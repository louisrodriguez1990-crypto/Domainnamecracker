import { ZodError } from "zod";
import { NextResponse } from "next/server";

import { parseWordUpload } from "@/lib/domain/normalization";
import { uploadSourceSchema } from "@/lib/domain/validation";
import { getDomainService } from "@/lib/server/domain-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const name = String(formData.get("name") ?? "").trim();
    const description = String(
      formData.get("description") ?? "Uploaded custom word list.",
    ).trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Upload a TXT or CSV file first." },
        { status: 400 },
      );
    }

    const metadata = uploadSourceSchema.parse({
      name: name || file.name.replace(/\.[^.]+$/, "") || "Custom Upload",
      description,
    });

    const words = parseWordUpload(await file.text());

    if (words.length < 3) {
      return NextResponse.json(
        {
          error: "Upload at least three usable words to create a source.",
        },
        { status: 400 },
      );
    }

    const source = await getDomainService().createUploadSource({
      name: metadata.name,
      description: metadata.description ?? "Uploaded custom word list.",
      words,
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid upload metadata." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to create the uploaded word source.",
      },
      { status: 500 },
    );
  }
}
