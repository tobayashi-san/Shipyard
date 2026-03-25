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
        "if [ -f /var/run/reboot-required ]; then echo 1; elif command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then echo 1; else echo 0; fi",
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
      const cmd = `if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq 2>/dev/null
  apt list --upgradable 2>/dev/null | grep "/"
  echo "---PHASED---"
  apt-get -s upgrade 2>/dev/null | awk '/^Inst /{print $2}'
  echo "---WOULDUPGRADE---"
elif command -v dnf >/dev/null 2>&1; then
  dnf check-update -q 2>/dev/null | awk 'NF>=3 && /^[a-zA-Z0-9]/{n=$1; sub(/\\.[^.]+$/,"",n); print n"/updates "$2}'
  echo "---PHASED---"
elif command -v yum >/dev/null 2>&1; then
  yum check-update -q 2>/dev/null | awk 'NF>=3 && /^[a-zA-Z0-9]/{n=$1; sub(/\\.[^.]+$/,"",n); print n"/updates "$2}'
  echo "---PHASED---"
elif command -v pacman >/dev/null 2>&1; then
  checkupdates 2>/dev/null | awk '{print $1"/arch "$4}'
  echo "---PHASED---"
elif command -v zypper >/dev/null 2>&1; then
  zypper -q list-updates 2>/dev/null | awk -F"|" 'NR>3 && NF>=5{gsub(/ /,"",$3); gsub(/ /,"",$5); if($3 && $3!="Name") print $3"/oss "$5}'
  echo "---PHASED---"
fi`;
      const result = await sshManager.execCommand(server, cmd);

      const [upgradableRaw = '', rest = ''] = result.stdout.split('---PHASED---');
      const [wouldUpgradeRaw = ''] = rest.split('---WOULDUPGRADE---');

      // Packages that apt would actually install (not blocked by phasing/deps)
      const wouldUpgradeSet = new Set(
        wouldUpgradeRaw.trim().split('\n').map(s => s.trim()).filter(Boolean)
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
            // Mark as phased if apt wouldn't actually upgrade it
            phased: wouldUpgradeSet.size > 0 ? !wouldUpgradeSet.has(pkg) : false,
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
        "dpkg-query -W -f='${Package} ${Version}\\n' 2>/dev/null | head -100 || rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null | head -100 || pacman -Q 2>/dev/null | head -100 || zypper search -i 2>/dev/null | awk -F'|' 'NR>3 && NF>=4{gsub(/ /,\"\",$3); gsub(/ /,\"\",$4); print $3\" \"$4}' | head -100"
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
