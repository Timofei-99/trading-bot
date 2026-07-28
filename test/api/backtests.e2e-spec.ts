import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types';

import { ApiModule } from '@bot/api/api.module';
import { CandleSourceService } from '@bot/app/candle-source.service';
import { ReportService } from '@bot/app/report.service';
import { loadGoldenCandles } from '../fixtures/helpers';

/**
 * The HTTP surface end to end: submit a run, poll it to completion, read the
 * trades back.
 *
 * The market-data service is replaced with one that answers from the committed
 * fixtures, so the suite stays offline — the same rule the Python tests kept.
 */
describe('backtests API', () => {
  let app: INestApplication;
  let reportsDir: string;

  beforeAll(async () => {
    reportsDir = mkdtempSync(join(tmpdir(), 'api-reports-'));

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(CandleSourceService)
      .useValue({
        load: async (_request: unknown, timeframe: string) =>
          loadGoldenCandles(timeframe === '1h' ? 'eurusd_1h' : 'eurusd_5m'),
      })
      .overrideProvider(ReportService)
      .useValue(new ReportService(reportsDir))
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(reportsDir, { recursive: true, force: true });
  });

  const server = (): App => app.getHttpServer() as App;

  const validBody = {
    strategy: '1h3m_classic',
    data: {
      source: 'binance',
      symbol: 'EURUSD=X',
      timeframes: ['1h', '5m'],
      start: '2024-05-06T00:00:00.000Z',
      end: '2024-05-22T00:00:00.000Z',
    },
    engine: { baseTimeframe: '5m', window: 500 },
    account: { initialBalance: 10_000, riskPerTrade: 0.01 },
  };

  it('reports its health', async () => {
    const response = await request(server()).get('/api/health').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('lists strategies with enough detail to build a request', async () => {
    const response = await request(server()).get('/api/strategies').expect(200);

    expect(response.body).toHaveLength(3);
    expect(response.body[0]).toMatchObject({
      id: 'OB_4h_FVG_15m',
      requiredTimeframes: ['4h', '15m'],
    });
  });

  describe('validation', () => {
    it('rejects an unknown data source', async () => {
      await request(server())
        .post('/api/backtests')
        .send({ ...validBody, data: { ...validBody.data, source: 'ftx' } })
        .expect(400);
    });

    it('rejects a missing strategy', async () => {
      const withoutStrategy = { ...validBody } as Partial<typeof validBody>;
      delete withoutStrategy.strategy;
      await request(server()).post('/api/backtests').send(withoutStrategy).expect(400);
    });

    it('rejects a non-ISO date', async () => {
      await request(server())
        .post('/api/backtests')
        .send({ ...validBody, data: { ...validBody.data, start: 'yesterday' } })
        .expect(400);
    });

    it('rejects a risk fraction above 1', async () => {
      await request(server())
        .post('/api/backtests')
        .send({ ...validBody, account: { riskPerTrade: 2 } })
        .expect(400);
    });

    it('rejects an absurd fee instead of silently accepting it', async () => {
      await request(server())
        .post('/api/backtests')
        .send({ ...validBody, account: { feeRate: 0.9 } })
        .expect(400);
    });
  });

  it('applies the trading costs it was given', async () => {
    // `whitelist: true` deletes undeclared properties, so a cost field missing
    // from the DTO would not fail here — it would quietly return a GROSS
    // result to a caller who asked for a net one. Assert the numbers differ.
    const post = async (account: Record<string, unknown>): Promise<Record<string, number>> => {
      const created = await request(server())
        .post('/api/backtests')
        .send({ ...validBody, account })
        .expect(202);

      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await request(server()).get(`/api/backtests/${created.body.id}`);
        if (response.body.status === 'completed') {
          return response.body.report;
        }
        if (response.body.status === 'failed') {
          throw new Error(`run failed: ${response.body.error}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('run did not finish');
    };

    const gross = await post({ initialBalance: 10_000 });
    const net = await post({ initialBalance: 10_000, feeRate: 0.001 });

    expect(net.totalTrades).toBe(gross.totalTrades);
    expect(net.totalPnlPct).toBeLessThan(gross.totalPnlPct);
    // Two fees per round trip, charged against the entry notional.
    expect(gross.totalPnlPct - net.totalPnlPct).toBeCloseTo(0.001 * 2 * gross.totalTrades, 3);
  });

  it('404s for an unknown run', async () => {
    await request(server()).get('/api/backtests/does-not-exist').expect(404);
  });

  describe('a full run', () => {
    let runId: string;

    it('accepts the request straight away', async () => {
      const response = await request(server()).post('/api/backtests').send(validBody).expect(202);

      expect(response.body.id).toEqual(expect.any(String));
      expect(['queued', 'running', 'completed']).toContain(response.body.status);
      runId = response.body.id;
    });

    it('finishes and reports its numbers', async () => {
      let body: Record<string, never> = {} as Record<string, never>;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await request(server()).get(`/api/backtests/${runId}`).expect(200);
        body = response.body;
        if (body.status === 'completed' || body.status === 'failed') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(body).toMatchObject({ status: 'completed', strategy: '1h3m_classic', error: null });
      // The same nine trades the parity fixture records for this dataset.
      expect(body.report).toMatchObject({ totalTrades: 9, winners: 6, losers: 3 });
    });

    it('returns the trades with their full signals', async () => {
      const response = await request(server()).get(`/api/backtests/${runId}/trades`).expect(200);

      expect(response.body).toHaveLength(9);
      expect(response.body[0]).toMatchObject({
        exitReason: 'tp',
        signal: { strategyName: '1h3m_classic', direction: 'long' },
      });
      expect(response.body[0].entryTime).toMatch(/^2024-05-\d{2}T/);
    });

    it('lists the run', async () => {
      const response = await request(server()).get('/api/backtests').expect(200);
      expect(response.body.map((run: { id: string }) => run.id)).toContain(runId);
    });
  });

  describe('reports', () => {
    it('lists generated files', async () => {
      writeFileSync(join(reportsDir, 'chart.html'), '<html>chart</html>');
      const response = await request(server()).get('/api/reports').expect(200);
      expect(response.body.map((file: { filename: string }) => file.filename)).toContain(
        'chart.html',
      );
    });

    it('serves one by name', async () => {
      const response = await request(server()).get('/api/reports/chart.html').expect(200);
      expect(response.text).toBe('<html>chart</html>');
    });

    it('404s for a name that does not exist', async () => {
      await request(server()).get('/api/reports/missing.html').expect(404);
    });

    it('refuses to walk out of the reports directory', async () => {
      await request(server()).get('/api/reports/..%2F..%2Fpackage.json').expect(400);
    });
  });
});
