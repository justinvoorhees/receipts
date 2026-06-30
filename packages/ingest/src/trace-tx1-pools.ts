/**
 * Full event sequence for TX1 (CLAWD→USDC sell) to verify WETH→USDC venue.
 */
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });
const TX = '0xbc853779e6c5f846a08917a1afc710e17181fd0a31983723e15080497f63fe54' as `0x${string}`;

const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const WETH  = '0x4200000000000000000000000000000000000006';
const USDC  = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CLAWD = '0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07';
const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const V4    = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const POOL_ABI = parseAbi(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)']);

const sym = (a: string) => {
  const l = a.toLowerCase();
  if (l === WETH.toLowerCase())  return 'WETH';
  if (l === USDC.toLowerCase())  return 'USDC';
  if (l === CLAWD.toLowerCase()) return 'CLAWD';
  if (l === cbBTC.toLowerCase()) return 'cbBTC';
  if (l === V4.toLowerCase())    return 'V4_PM';
  return a.slice(0, 10);
};

const receipt = await rpc.getTransactionReceipt({ hash: TX });
console.log(`Total logs: ${receipt.logs.length}\n`);

for (const [i, l] of receipt.logs.entries()) {
  const t0 = l.topics[0];
  if (t0 === TRANSFER) {
    const from = '0x' + l.topics[1]!.slice(26);
    const to   = '0x' + l.topics[2]!.slice(26);
    const val  = BigInt(l.data);
    console.log(`[${i}] Transfer  ${sym(l.address).padEnd(6)} from=${sym(from).padEnd(10)} to=${sym(to).padEnd(10)} val=${val}`);
  } else if (t0 === SWAP_V3) {
    const [tok0, tok1, fee] = await Promise.all([
      rpc.readContract({ address: l.address as `0x${string}`, abi: POOL_ABI, functionName: 'token0' }).catch(() => '?'),
      rpc.readContract({ address: l.address as `0x${string}`, abi: POOL_ABI, functionName: 'token1' }).catch(() => '?'),
      rpc.readContract({ address: l.address as `0x${string}`, abi: POOL_ABI, functionName: 'fee' }).catch(() => 0),
    ]);
    console.log(`[${i}] V3 Swap   pool=${l.address} (${sym(tok0 as string)}/${sym(tok1 as string)} fee=${fee})`);
  } else {
    console.log(`[${i}] Other     addr=${sym(l.address).padEnd(10)} topic=${t0?.slice(0, 18)}`);
  }
}
