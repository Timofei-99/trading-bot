import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { TIMEFRAME_MINUTES } from '../../domain/market-context';

export class BacktestDataDto {
  @IsIn(['binance', 'yahoo', 'mt5'])
  source!: 'binance' | 'yahoo' | 'mt5';

  @IsString()
  symbol!: string;

  /**
   * Restricted to known timeframes: the value reaches a cache filename, and
   * an unconstrained string there escapes the cache directory.
   */
  @IsArray()
  @IsIn(Object.keys(TIMEFRAME_MINUTES), { each: true })
  timeframes!: string[];

  @IsISO8601()
  start!: string;

  @IsISO8601()
  end!: string;

  @IsOptional()
  @IsString()
  csvPath?: string;

  @IsOptional()
  @IsString()
  sourceTz?: string;
}

export class BacktestEngineDto {
  @IsOptional()
  @IsString()
  baseTimeframe?: string;

  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(200_000)
  window?: number;
}

export class BacktestAccountDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  initialBalance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  riskPerTrade?: number;

  /**
   * Trading costs. These MUST be declared here even though the runner would
   * accept them anyway: `whitelist: true` deletes undeclared properties, so an
   * omission does not fail the request — it silently returns a gross result to
   * a caller who asked for a net one.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  feeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.5)
  slippage?: number;

  @IsOptional()
  @IsBoolean()
  worstCase?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  maxDailyDrawdown?: number;
}

/**
 * A backtest request over HTTP.
 *
 * `ValidationPipe({whitelist: true})` strips anything not declared here, so
 * the DTO is the boundary: nothing reaches the domain that has not been named
 * and type-checked.
 */
export class BacktestRequestDto {
  @IsString()
  strategy!: string;

  @IsOptional()
  @IsObject()
  strategyParams?: Record<string, unknown>;

  @ValidateNested()
  @Type(() => BacktestDataDto)
  data!: BacktestDataDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacktestEngineDto)
  engine?: BacktestEngineDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => BacktestAccountDto)
  account?: BacktestAccountDto;
}
