import { NextResponse } from "next/server";

import { getDomainService } from "@/lib/server/domain-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getDomainService().getHistory());
}
