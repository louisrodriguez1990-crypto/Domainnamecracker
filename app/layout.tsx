import type { Metadata } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Domain Availability Hunter",
  description:
    "Generate high-value domain name combinations, check availability, and keep local search history.",
};

const backgroundLabel =
  "radial-gradient(circle at 20% 20%, rgba(225, 122, 37, 0.18), transparent 30%), radial-gradient(circle at 80% 0%, rgba(27, 115, 107, 0.22), transparent 28%), linear-gradient(180deg, #f4eadc 0%, #efe1cc 48%, #ead8c1 100%)";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body
        className="min-h-full flex flex-col text-stone-900"
        style={{ backgroundImage: backgroundLabel }}
      >
        {children}
      </body>
    </html>
  );
}
