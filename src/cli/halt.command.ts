import { Command, CommandRunner, Option } from 'nest-commander';

import { JournalEvent } from '../domain/order';
import { NdjsonTradeJournal } from '../infrastructure/journal/ndjson-trade-journal';

interface HaltOptions {
  journal?: string;
  reason?: string;
  note?: string;
}

/**
 * Manual stop, applied through the journal rather than through the process.
 *
 * The running bot replays the journal on startup and consults the kill switch
 * before every entry, so writing a halt here stops the bot at its next tick
 * and — more importantly — keeps it stopped after a restart. No signal
 * handling, no IPC, and it works even when the bot is not currently running.
 */
@Command({ name: 'halt', description: 'Stop a bot from opening new positions (survives restarts)' })
export class HaltCommand extends CommandRunner {
  async run(_args: string[], options: HaltOptions = {}): Promise<void> {
    const journal = requireJournal(options.journal);
    const event: JournalEvent = {
      type: 'halted',
      at: Date.now(),
      reason: options.reason ?? 'halted manually',
    };
    journal.append(event);

    console.log(`halted: ${event.reason}`);
    console.log('The bot will stop opening positions at its next tick.');
    console.log('An OPEN POSITION IS LEFT ALONE — its stop is at the venue. Close it yourself if you want out.');
  }

  @Option({ flags: '--journal <path>', description: 'Journal file of the bot to stop' })
  parseJournal(value: string): string {
    return value;
  }

  @Option({ flags: '--reason <text>', description: 'Why, for the record' })
  parseReason(value: string): string {
    return value;
  }
}

@Command({ name: 'resume', description: 'Clear a halt so the bot may open positions again' })
export class ResumeCommand extends CommandRunner {
  async run(_args: string[], options: HaltOptions = {}): Promise<void> {
    const journal = requireJournal(options.journal);
    const halted = journal
      .readAll()
      .filter((event) => event.type === 'halted' || event.type === 'resumed');

    if (halted.length === 0 || halted[halted.length - 1].type === 'resumed') {
      console.log('not halted; nothing to resume');
      return;
    }

    journal.append({ type: 'resumed', at: Date.now(), note: options.note ?? 'resumed manually' });
    console.log('resumed: the bot may open positions again at its next tick');
  }

  @Option({ flags: '--journal <path>', description: 'Journal file of the bot to resume' })
  parseJournal(value: string): string {
    return value;
  }

  @Option({ flags: '--note <text>', description: 'Why, for the record' })
  parseNote(value: string): string {
    return value;
  }
}

function requireJournal(path: string | undefined): NdjsonTradeJournal {
  if (path === undefined) {
    throw new Error('--journal is required: name the journal file the bot was started with');
  }
  return new NdjsonTradeJournal(path);
}
