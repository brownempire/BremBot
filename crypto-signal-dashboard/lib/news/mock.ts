export type NewsItem = {
  id: string;
  source: string;
  headline: string;
  sentiment: number; // -1 to 1
  timestamp: number;
};

const headlines = [
  "Large BTC options expiry clusters near resistance",
  "ETH staking inflows rise as validator queue grows",
  "Solana ecosystem TVL bounces on NFT demand",
  "Macro risk-off move hits high beta crypto",
  "Layer-1 dev activity surges ahead of upgrade",
];

export function getMockNews(): NewsItem[] {
  const now = Date.now();
  return headlines.map((headline, index) => ({
    id: `mock-${index}`,
    source: "X (mock)",
    headline,
    sentiment: Math.sin(now / 900000 + index) * 0.8,
    timestamp: now - index * 60000,
  }));
}
