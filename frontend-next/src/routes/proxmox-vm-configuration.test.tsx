import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {VmConfigurationOverview} from '@/features/infrastructure/VmConfigurationOverview';
const render=(props:Parameters<typeof VmConfigurationOverview>[0])=>renderToStaticMarkup(<VmConfigurationOverview {...props}/>);
const base={loading:false,unavailable:false,onRetry:()=>{}};
it('shows LXC facts and preserves zero limits without VM-only defaults',()=>{
 const html=render({...base,guestType:'lxc',configuration:{guest_type:'lxc',hardware:{cores:2,memory_mb:1024},container:{architecture:'amd64',unprivileged:true,swap_mb:0,cpu_limit:0},disks:[{bus:'rootfs',storage:'local:root'},{bus:'mp0',storage:'/data'}]}});
 for(const value of ['Container configuration','Unprivileged','0 MB','No CPU time limit','Root filesystem','mp0'])expect(html).toContain(value);
 for(const value of ['QEMU agent','BIOS','Boot order','Cloud-Init','socket'])expect(html).not.toContain(value);
});
it('does not turn missing LXC metadata into privileged mode or VM defaults',()=>{
 const html=render({...base,guestType:'lxc',configuration:{hardware:{cores:1}}});
 expect(html).toContain('Not reported');expect(html).not.toContain('>Privileged<');expect(html).not.toContain('Proxmox default');
});
it('keeps QEMU configuration and its reachability caveat',()=>{
 const html=render({...base,guestType:'qemu',configuration:{guest_type:'qemu',hardware:{cores:2,agent_enabled:true,bios:'ovmf'},guest:{username:'debian'}}});
 expect(html).toContain('QEMU agent configuration');expect(html).toContain('guest reachability not checked');expect(html).toContain('ovmf');expect(html).toContain('debian');expect(html).not.toContain('Privilege mode');
});

it.each([['qemu','Virtual machine'],['lxc','Container']] as const)('renders an actionable %s configuration error instead of empty facts', (guestType,label)=>{
 const html=render({...base,guestType,error:new Error('Fixture request failed')});
 expect(html).toContain(`${label} configuration could not be loaded`);
 expect(html).toContain('Fixture request failed');
 expect(html).toContain('Try again');
 expect(html).not.toContain('Not reported');
 expect(html).not.toContain('Proxmox default');
});

it('distinguishes an unconfigured platform connection from a request failure',()=>{
 const html=render({...base,guestType:'lxc',unavailable:true});
 expect(html).toContain('no direct platform connection configured');
 expect(html).not.toContain('could not be loaded');
 expect(html).not.toContain('Try again');
});
