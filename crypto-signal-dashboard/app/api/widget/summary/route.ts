import { loadWidgetServerSnapshot } from "@/lib/widget/serverSnapshot";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "public, max-age=15, s-maxage=20, stale-while-revalidate=60",
  "X-Content-Type-Options": "nosniff",
};

export async function GET() {
  try {
    return Response.json(await loadWidgetServerSnapshot(), { headers: responseHeaders });
  } catch (error) {
    console.error("Widget summary unavailable", error);
    return Response.json(
      { error: "The widget summary is temporarily unavailable." },
      { status: 503, headers: responseHeaders }
    );
  }
}
