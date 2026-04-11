import { getRequiredJava } from './src/utils/java.js';

const versions = ['1.21.1', '1.25.0', '26.1.2', '25w01a', '24w14a'];
versions.forEach(v => {
  console.log(`${v} -> Java ${getRequiredJava(v)}`);
});
