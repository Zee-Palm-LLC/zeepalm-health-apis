import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zee Palm Health APIs",
  description: "10 open-source healthcare, fitness and wellness APIs. Deploy to Vercel, add your key, ship.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
