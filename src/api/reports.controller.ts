import { BadRequestException, Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { existsSync } from 'node:fs';

import { ReportFile, ReportService } from '../application/report.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportService) {}

  @Get()
  list(): ReportFile[] {
    return this.reports.list();
  }

  /**
   * Serve a generated report.
   *
   * The filename comes straight from the URL, so `ReportService.pathFor`
   * rejects anything that is not a plain name in the reports directory before
   * a read is attempted.
   */
  @Get(':filename')
  @Header('Content-Type', 'text/html; charset=utf-8')
  read(@Param('filename') filename: string): string {
    let path: string;
    try {
      path = this.reports.pathFor(filename);
    } catch {
      throw new BadRequestException(`Invalid report filename: ${filename}`);
    }
    if (!existsSync(path)) {
      throw new NotFoundException(`No report named ${filename}`);
    }
    return this.reports.read(filename);
  }
}
