import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'proofplane — run it in the browser',
  description:
    'A hosted demo of proofplane: boot the real deliberately-non-compliant agentic target, run the real adversarial probe suite against it, and watch a control become HELD only when an executed attack failed.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
