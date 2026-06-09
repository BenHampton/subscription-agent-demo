import { NextResponse } from 'next/server';
import { getMetrics } from '@/lib/eval/metrics';

// Returns aggregate agent performance metrics.
// In production, this would be behind authentication.

export async function GET() {
  const metrics = await getMetrics();
  return NextResponse.json(metrics);
}

// Usage: curl http://localhost:3000/api/agent/metrics
//
// Response:
// {
//   "totalInteractions": 47,
//   "resolutionRate": 89,
//   "escalationRate": 8,
//   "averageConfidence": 0.87,
//   "averageToolCalls": 3.2,
//   "averageDurationMs": 4200,
//   "confirmationRate": 15
// }
