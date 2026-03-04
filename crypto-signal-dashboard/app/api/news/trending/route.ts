import { getMockNews, type NewsItem } from "@/lib/news/mock";

type FeedItem = Pick<NewsItem, "source" | "headline" | "sentiment" | "timestamp" | "url">;

function stripHtml(input: string) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRssItems(xml: string, source: string, limit = 4): FeedItem[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  return items.map((match, idx) => {
    const chunk = match[1] ?? "";
    const title = stripHtml(chunk.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "Untitled");
    const rawLink = stripHtml(chunk.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "");
    const pubDate = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    const lower = title.toLowerCase();
    const positiveWords = ["surge", "gain", "bull", "rally", "breakout", "approval", "inflow"];
    const negativeWords = ["drop", "loss", "bear", "hack", "outflow", "lawsuit", "selloff"];
    const sentiment =
      positiveWords.some((word) => lower.includes(word)) ? 0.55 :
        negativeWords.some((word) => lower.includes(word)) ? -0.55 :
          0;

    return {
      source,
      headline: title,
      sentiment,
      timestamp: pubDate ? Date.parse(pubDate) || Date.now() - idx * 60_000 : Date.now() - idx * 60_000,
      url: rawLink.startsWith("http") ? rawLink : undefined,
    };
  });
}

async function fetchRss(url: string, source: string, limit = 4): Promise<FeedItem[]> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml, application/json",
      "User-Agent": "BremBot/1.0",
    },
  });
  if (!response.ok) return [];
  const text = await response.text();
  if (!text.includes("<item>")) return [];
  return parseRssItems(text, source, limit);
}

export async function GET() {
  const [xPosts, majorHeadlines] = await Promise.all([
    fetchRss("https://nitter.net/search/rss?f=tweets&q=solana+OR+bitcoin+OR+ethereum", "X trending", 5).catch(() => []),
    fetchRss("https://news.google.com/rss/search?q=crypto+markets+when:1d&hl=en-US&gl=US&ceid=US:en", "Major outlets", 5).catch(() => []),
  ]);

  const feed = [...xPosts, ...majorHeadlines]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10)
    .map((item, idx) => ({
      id: `live-${idx}-${item.timestamp}`,
      ...item,
    }));

  if (feed.length === 0) {
    return new Response(JSON.stringify({ items: getMockNews(), source: "fallback" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ items: feed, source: "rss" }), {
    headers: { "Content-Type": "application/json" },
  });
}
