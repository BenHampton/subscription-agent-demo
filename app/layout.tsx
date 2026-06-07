// root layout required by Next.js App Router even for API-only projects.
// This file exists solely to satisfy the framework; our actual work happens in
// app/api/ route handlers.

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
