import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Skylark BI — monday.com Business Intelligence Agent',
  description:
    'Founder-level business intelligence over monday.com Deal Funnel and Work Order Tracker boards, with honest handling of messy real-world data.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#059669',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
