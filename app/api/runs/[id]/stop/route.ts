import { NextResponse } from "next/server";

import { getDomainService } from "@/lib/server/domain-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const snapshot = await getDomainService().stopRun(id);

  if (!snapshot) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json(snapshot);
}
