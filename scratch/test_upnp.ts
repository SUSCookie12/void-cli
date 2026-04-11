import { tryPortForward, removePortForward, getPublicIp } from '../src/network/portForwarding.js';

async function test() {
  console.log('--- UPnP Test ---');
  const ip = await getPublicIp();
  console.log('Public IP:', ip);
  
  const success = await tryPortForward(25565, 25565);
  if (success) {
    console.log('UPnP Success!');
    await removePortForward(25565);
  } else {
    console.log('UPnP Failed. (Router might not support it or it is disabled)');
  }
  process.exit(0);
}

test();
