import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const TX = '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54' as `0x${string}`;
const OFP_TOPIC = '0x19b47279256b2a23a1471253758fad949878ee17';  // partial

const receipt = await rpc.getTransactionReceipt({ hash: TX });
// Print all log emitter addresses with their topic0
for (const l of receipt.logs) {
  if (l.topics[0]?.startsWith('0x19b47279')) {
    console.log('OFP fill at:', l.address);
  }
}
// Also print all unique log addresses
const addrs = [...new Set(receipt.logs.map(l => l.address))];
console.log('\nAll emitters:', addrs.join('\n  '));
