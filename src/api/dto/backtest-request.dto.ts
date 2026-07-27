import { Type } from 'class-transformer';
import {
  IsArray,
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

export class BacktestDataDto {
  @IsIn(['binance', 'yahoo', 'mt5'])
  source!: 'binance' | 'yahoo' | 'mt5';

  @IsString()
  symbol!: string;

  @IsArray()
  @IsString({ each: true })
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
