import { Injectable } from '@nestjs/common';

import { Trade } from '../domain/trade';
import { BacktestReport } from '../execution/backtest.adapter';
import { BacktestRequest, BacktestRunnerService } from './backtest-runner.service';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface RunRecord {
  readonly id: string;
  status: RunStatus;
  readonly request: BacktestRequest;
  readonly createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  report: BacktestReport | null;
  trades: Trade[];
  openTrades: Trade[];
  finalBalance: number | null;
  error: string | null;
}

/**
 * In-process registry of backtest runs.
 *
 * Runs are asynchronous but stay in memory: the workload is one operator on
 * one machine, so a queue and a database would be infrastructure without a
 * problem to solve. Everything here is replaceable behind the same three
 * methods if that ever changes.
 */
@Injectable()
export class RunRegistryService {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly runner: BacktestRunnerService) {}

  /** Register the run and start it; returns immediately with the record. */
  submit(request: BacktestRequest, nowMs = Date.now()): RunRecord {
    const record: RunRecord = {
      id: globalThis.crypto.randomUUID(),
      status: 'queued',
      request,
      createdAtMs: nowMs,
      startedAtMs: null,
      finishedAtMs: null,
      report: null,
      trades: [],
      openTrades: [],
      finalBalance: null,
      error: null,
    };
    this.runs.set(record.id, record);
    void this.execute(record);
    return record;
  }

  get(id: string): RunRecord | null {
    return this.runs.get(id) ?? null;
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  private async execute(record: RunRecord): Promise<void> {
    record.status = 'running';
    record.startedAtMs = Date.now();
    try {
      const outcome = await this.runner.run(record.request);
      record.report = outcome.report;
      record.trades = outcome.trades;
      record.openTrades = outcome.openTrades;
      record.finalBalance = outcome.finalBalance;
      record.status = 'completed';
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      // The full reason stays here; the HTTP layer only reports a summary.
      console.error(`run ${record.id} failed: ${record.error}`);
      record.status = 'failed';
    } finally {
      record.finishedAtMs = Date.now();
    }
  }
}
