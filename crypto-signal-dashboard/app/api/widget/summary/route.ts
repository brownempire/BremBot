import { loadWidgetServerSnapshot } from "@/lib/widget/serverSnapshot";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
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
