import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth , sanitizeError } from "@/lib/middleware";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    const userDetails = await prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
      },
    });

    const hasGoogleAccount =
      (await prisma.account.count({
        where: { userId: user.userId, provider: "google" },
      })) > 0;

    if (!userDetails) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: userDetails.id,
      name: userDetails.name,
      email: userDetails.email,
      image: userDetails.image,
      createdAt: userDetails.createdAt,
      avatarUrl: (userDetails as any).image,
      isGoogleLinked: hasGoogleAccount,
    });
  } catch (error: any) {
    console.error("Error fetching user:", sanitizeError(error));
    return NextResponse.json(
      { error: "Failed to fetch user" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    await prisma.user.delete({
      where: { id: user.userId },
    });

    const response = NextResponse.json({ message: "Account deleted" });

    // Clear active session cookies to invalidate server/client session cookies immediately
    response.cookies.delete("next-auth.session-token");
    response.cookies.delete("__Secure-next-auth.session-token");
    response.cookies.delete("next-auth.callback-url");
    response.cookies.delete("next-auth.csrf-token");

    return response;
  } catch (error: any) {
    console.error("Error deleting account:", sanitizeError(error));
    if (error?.code === "P2025") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }
}
