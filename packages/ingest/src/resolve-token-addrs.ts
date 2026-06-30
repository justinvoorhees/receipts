/**
 * Resolve full addresses for FAIR, CLAWD, LFI, GITLAWB from the pools we know about.
 * Run: set -a && source .env && set +a && npx tsx packages/ingest/src/resolve-token-addrs.ts
 */
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);
const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const rpc = createPublicClient({ chain: base, transport: http(process.env.TCA_RPC_URL!) });

async function tokenInfo(addr: string) {
  const [name, symbol, decimals] = await Promise.all([
    rpc.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: 'name' }).catch(() => '?'),
    rpc.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '?'),
    rpc.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { name, symbol, decimals };
}

const pools: { label: string; addr: string; knownToken: string }[] = [
  { label: 'WETH/FAIR (fabric $2132)', addr: '0xfc01837343cfc2a9ddca9e8a0a19825f6b2f0460', knownToken: WETH },
  { label: 'WETH/CLAWD (fabric $1447,$1404)', addr: '0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3', knownToken: WETH },
  { label: 'LFI/WETH (fabric $1342)', addr: '0x588f68b9fa04366f33f8ce095c13f0cebab9406a', knownToken: WETH },
  { label: 'LFI/USDC (fabric $1342)', addr: '0x41932ea9b35bd2e663678dfca8228498a05a3689', knownToken: USDC },
  { label: 'USDC/CLAWD (fabric $1404)', addr: '0xb72a6e1091d43e19284050b7132e0646509eba5d', knownToken: USDC },
];

for (const p of pools) {
  const [t0, t1] = await Promise.all([
    rpc.readContract({ address: p.addr as `0x${string}`, abi: POOL_ABI, functionName: 'token0' }),
    rpc.readContract({ address: p.addr as `0x${string}`, abi: POOL_ABI, functionName: 'token1' }),
  ]);
  const unknownAddr = t0.toLowerCase() === p.knownToken.toLowerCase() ? t1 : t0;
  const info = await tokenInfo(unknownAddr);
  console.log(`${p.label}`);
  console.log(`  pool: ${p.addr}`);
  console.log(`  token: '${unknownAddr}': '${info.symbol}',  // ${info.name}  decimals=${info.decimals}`);
}

// GITLAWB: find its address from the $1342 trade transfer logs via a quick trace
// We know it transferred from 0x498581ff718922c3f8e6a244956af099b2652b2b (V4 poolmanager)
// Let's check what the GITLAWB token contract is by looking at the $1342 trace
console.log('\n--- Scanning $1342 trace for GITLAWB token address ---');
const trace = await (rpc.request as unknown as (r: { method: string; params: unknown[] }) => Promise<{
  logs?: { address: string; topics: string[]; data: string }[];
  calls?: unknown[];
}>)({
  method: 'debug_traceTransaction',
  params: [
    '0xe4b9514743e4f211b456f14c69fd3c4abddf68a620becbdcb1ffa7771c42f4b7',
    { tracer: 'callTracer', tracerConfig: { withLog: true, onlyTopCall: false } },
  ],
});

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const knownTokenAddrs = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x4200000000000000000000000000000000000006', // WETH
  '0x9f86ba658fabe3db1b5d18b2fe21611dee03f398', // suspected CLAWD (placeholder)
]);

function flatLogs(t: unknown): { address: string; topics: string[] }[] {
  const out: { address: string; topics: string[] }[] = [];
  const visit = (n: { logs?: { address: string; topics: string[] }[]; calls?: unknown[] }) => {
    if (n.logs) out.push(...n.logs);
    n.calls?.forEach(c => visit(c as typeof n));
  };
  visit(t as { logs?: { address: string; topics: string[] }[]; calls?: unknown[] });
  return out;
}

const allLogs = flatLogs(trace);
const transferContracts = new Set<string>();
for (const l of allLogs) {
  if (l.topics[0] === TRANSFER_TOPIC) transferContracts.add(l.address.toLowerCase());
}

const KNOWN = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x4200000000000000000000000000000000000006']);
const candidateLfi = new Set<string>();
for (const addr of transferContracts) {
  if (!KNOWN.has(addr)) candidateLfi.add(addr);
}

for (const addr of candidateLfi) {
  const info = await tokenInfo(addr);
  console.log(`  '${addr}': '${info.symbol}',  // ${info.name}  decimals=${info.decimals}`);
}
