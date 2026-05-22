import { NextResponse } from 'next/server';
import { startAnalysisWorkerLoop } from '../../../../scripts/analysisWorker';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const requestStart = Date.now();

  try {
    // Auth check
    const authHeader = request.headers.get('authorization');

    if (
      process.env.ANALYSIS_RUNNER_SECRET &&
      authHeader !== `Bearer ${process.env.ANALYSIS_RUNNER_SECRET}`
    ) {
      console.warn('[run-analysis] Unauthorized access attempt');

      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const timeBudgetStr = searchParams.get('timeBudgetMs');

    // Default budget: 45s
    let timeBudgetMs = 45000;

    if (timeBudgetStr) {
      const parsed = Number(timeBudgetStr);

      if (!Number.isNaN(parsed) && parsed > 0) {
        timeBudgetMs = parsed;
      } else {
        console.warn(
          `[run-analysis] Invalid timeBudgetMs received: ${timeBudgetStr}`
        );
      }
    }

    console.log(
      `[run-analysis] Starting worker loop with budget ${timeBudgetMs}ms`
    );

    const workerStart = Date.now();

    await startAnalysisWorkerLoop({
      once: false,
      timeBudgetMs,
    });

    const workerElapsed = Date.now() - workerStart;
    const totalElapsed = Date.now() - requestStart;

    console.log(
      `[run-analysis] Worker completed successfully in ${workerElapsed}ms`
    );

    return NextResponse.json({
      success: true,
      message: 'Analysis cron completed successfully',
      workerElapsedMs: workerElapsed,
      totalElapsedMs: totalElapsed,
      timeBudgetMs,
    });
  } catch (error) {
    const elapsed = Date.now() - requestStart;

    console.error(
      '[run-analysis] Cron execution failed',
      error instanceof Error
        ? {
            message: error.message,
            stack: error.stack,
            elapsedMs: elapsed,
          }
        : error
    );

    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        elapsedMs: elapsed,
      },
      { status: 500 }
    );
  }
}
