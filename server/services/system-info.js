const sshManager = require('./ssh-manager');

class SystemInfoService {
  /**
   * Gather comprehensive system information from a server
   */
  async getSystemInfo(server) {
    try {
      // All info in a single SSH call – one channel, one round-trip
      const script = [
        "grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'\"' -f2 || echo N/A",
        "uname -r 2>/dev/null || echo N/A",
        "grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d':' -f2 | xargs || echo N/A",
        "nproc 2>/dev/null || echo 0",
        "free -m 2>/dev/null | awk 'NR==2{printf \"%s %s\",$2,$3}' || echo '0 0'",
        "df -BG / 2>/dev/null | awk 'NR==2{printf \"%s %s\",$2,$3}' | tr -d G || echo '0 0'",
        "cut -d' ' -f1 /proc/uptime 2>/dev/null || echo 0",
        "cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '0 0 0'",
        "hostname 2>/dev/null || echo unknown",
        "[ -f /var/run/reboot-required ] && echo 1 || echo 0",
        // Two-sample CPU usage: pipe both /proc/stat reads into awk – no variable passing, no quoting issues
        "(grep '^cpu ' /proc/stat; sleep 1; grep '^cpu ' /proc/stat) | awk 'NR==1{for(i=2;i<=NF;i++)a[i]=$i} NR==2{t=0;for(i=2;i<=NF;i++)t+=$i-a[i];print(t>0?int(100*(t-($5-a[5]))/t):0)}' || echo 0",
      ].join('; echo "---SEP---"; ');

      const result = await sshManager.execCommand(server, script);
      const parts = result.stdout.split('---SEP---').map(s => s.trim());

      const results = {
        os:        parts[0] || 'N/A',
        kernel:    parts[1] || 'N/A',
        cpu:       parts[2] || 'N/A',
        cpu_cores: parts[3] || '0',
        ram:       parts[4] || '0 0',
        disk:      parts[5] || '0 0',
        uptime:    parts[6] || '0',
        load:      parts[7] || '0 0 0',
        hostname:  parts[8] || server.hostname,
        reboot:    parts[9] || '0',
        cpu_usage: parts[10] || '0',
      };

      const [ramTotal, ramUsed] = (results.ram || '0 0').split(' ').map(Number);
      const [diskTotal, diskUsed] = (results.disk || '0 0').split(' ').map(Number);

      return {
        os: results.os || 'Unknown',
        kernel: results.kernel || 'Unknown',
        cpu: results.cpu || 'Unknown',
        cpu_cores: parseInt(results.cpu_cores) || 0,
        ram_total_mb: ramTotal,
        ram_used_mb: ramUsed,
        disk_total_gb: diskTotal,
        disk_used_gb: diskUsed,
        uptime_seconds: Math.floor(parseFloat(results.uptime) || 0),
        load_avg: results.load || '0 0 0',
        hostname: results.hostname || server.hostname,
        reboot_required: (results.reboot && results.reboot.trim() === '1'),
        cpu_usage_pct: Math.min(100, Math.max(0, parseInt(results.cpu_usage) || 0)),
      };
    } catch (error) {
      throw new Error(`Failed to gather system info: ${error.message}`);
    }
  }

  /**
   * Get running services on a server
   */
  async getServices(server) {
    try {
      const result = await sshManager.execCommand(server,
        "systemctl list-units --type=service --state=running --no-pager --no-legend | awk '{print $1, $4}'"
      );

      const services = result.stdout.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.trim().split(/\s+/);
          return {
            name: parts[0].replace('.service', ''),
            status: parts[1] || 'running',
          };
        });

      return services;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get available package updates
   */
  async getAvailableUpdates(server) {
    try {
      const result = await sshManager.execCommand(server,
        '(apt list --upgradable 2>/dev/null | grep "/" || yum list updates -q 2>/dev/null); echo "---PHASED---"; apt-get -s dist-upgrade 2>/dev/null | awk \'/deferred due to phasing:/{p=1;next} p&&/^[0-9]/{exit} p&&NF{print $1}\' 2>/dev/null || true'
      );

      const [upgradableRaw = '', phasedRaw = ''] = result.stdout.split('---PHASED---');

      const phasedSet = new Set(
        phasedRaw.trim().split('\n').map(s => s.trim()).filter(Boolean)
      );

      const updates = upgradableRaw.trim().split('\n')
        .filter(line => line.trim() && line.includes('/'))
        .map(line => {
          const parts = line.split(/\s+/);
          const pkg = parts[0]?.split('/')[0] || parts[0];
          return {
            package: pkg,
            version: parts[1] || 'unknown',
            source: parts[2] || '',
            phased: phasedSet.has(pkg),
          };
        })
        .filter(u => u.package);

      return updates;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get installed packages with versions (filtered to important ones)
   */
  async getInstalledPackages(server) {
    try {
      const result = await sshManager.execCommand(server,
        "dpkg-query -W -f='${Package} ${Version}\\n' 2>/dev/null | head -100 || rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null | head -100"
      );

      return result.stdout.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [name, ...versionParts] = line.trim().split(' ');
          return { name, version: versionParts.join(' ') };
        });
    } catch {
      return [];
    }
  }
}

module.exports = new SystemInfoService();
