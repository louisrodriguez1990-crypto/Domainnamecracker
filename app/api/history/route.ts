import { NextResponse } from "next/server";

import { getRunManager } from "@/lib/server/run-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getRunManager().getHistory());
}
