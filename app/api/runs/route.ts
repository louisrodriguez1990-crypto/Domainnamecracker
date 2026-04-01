import { ZodError } from "zod";
import { NextResponse } from "next/server";

import { runConfigSchema } from "@/lib/domain/validation";
import { getRunManager } from "@/lib/server/run-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const config = runConfigSchema.parse(payload);
    const snapshot = await getRunManager().startRun(config);

    return NextResponse.json(snapshot, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: error.issues[0]?.message ?? "Invalid run configuration.",
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start the requested scan.",
      },
      { status: 409 },
    );
  }
}
