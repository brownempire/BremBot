import { NextRequest } from "next/server";

import { fetchJupiterPerpsAccountSnapshot } from "@/lib/jupiterPerps";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const walletAddress = request.nextUrl.searchParams.get("wallet")?.trim();

  if (!walletAddress) {
    return Response.json({ error: "Missing wallet address." }, { status: 400 });
  }

  try {
    const snapshot = await fetchJupiterPerpsAccountSnapshot(walletAddress);
    return Response.json(snapshot, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load Jupiter Perps positions right now.";
    return Response.json(
      { error: message },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  }
}
