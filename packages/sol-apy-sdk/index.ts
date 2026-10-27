import fetchPonyfill from 'fetch-ponyfill';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { pairs } from './known-spl-pools';
const { fetch } = fetchPonyfill();

export { pairs } from './known-spl-pools';

const DATA_SOURCE_BASE =
  'https://raw.githubusercontent.com/glitchful-dev/sol-stake-pool-apy/master/db/';

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * APY-1 Fix: Fetches a URL, rejects non-2xx responses, and aborts after a timeout so a
 * stalled request cannot hang the whole update job.
 */
const fetchWithTimeout = async (
  url: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`
      );
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
};

export type PriceRecord = {
  timestamp: number;
  epoch: number;
  price: number;
};

export type ApyCalcResult = {
  timestampStart: number;
  timestampEnd: number;
  epochs: number;
  apy: number;
};

export const parsePriceRecordsFromCSV = async (
  csv: Readable
): Promise<PriceRecord[]> => {
  const csvParser = parse({ delimiter: ',', columns: true });
  const records = [];
  for await (const row of csv.pipe(csvParser)) {
    const { timestamp, epoch, price } = row;
    if (!timestamp || !epoch || !price) {
      throw new Error('Columns "timestamp", "epoch", "price" must be present!');
    }
    const record = {
      timestamp: Math.round(new Date(timestamp).getTime() / 1e3),
      epoch: Number(epoch),
      price: Number(price),
    };
    if (isNaN(record.timestamp)) {
      throw new Error('Timestamp must be a... timestamp!');
    }
    if (isNaN(record.epoch)) {
      throw new Error('Epoch must be a number!');
    }
    if (isNaN(record.price)) {
      throw new Error('Price must be a number!');
    }

    records.push(record);
  }
  return records;
};

export const fetchCSVLink = (poolAddress: string): string => {
  const knownName = pairs[poolAddress];
  // APY-2 Fix: Explicit error instead of fetching undefined.csv
  if (!knownName) {
    throw new Error(`Unknown stake pool address: ${poolAddress}`);
  }
  return `${DATA_SOURCE_BASE}${knownName}.csv`;
};

export const fetchPricesFromCsv = async (poolAddress: string) => {
  const csvLink = fetchCSVLink(poolAddress);
  const csvResponse = await fetchWithTimeout(csvLink);
  const csvContents = await csvResponse.text();
  const prices = await parsePriceRecordsFromCSV(Readable.from([csvContents]));

  return prices;
};

export const fetchAndParsePricesCsv = async (url: string) => {
  const csvResponse = await fetchWithTimeout(url);
  const csvContents = await csvResponse.text();
  const prices = await parsePriceRecordsFromCSV(Readable.from([csvContents]));

  return prices;
};

const enum SECONDS_PER {
  DAY = 24 * 3600,
  YEAR = 365.25 * 24 * 3600
}

export enum PERIOD {
  DAYS_7 = 7 * SECONDS_PER.DAY,
  DAYS_14 = 14 * SECONDS_PER.DAY,
  DAYS_30 = 30 * SECONDS_PER.DAY,
  DAYS_90 = 90 * SECONDS_PER.DAY,
  DAYS_365 = 365 * SECONDS_PER.DAY,
}

type PriceRange = {
  startPrice: number
  endPrice: number
  startTimestamp: number
  endTimestamp: number
  startEpoch: number
  endEpoch: number
}

export const getPriceRange = (priceRecords: PriceRecord[], startTimestamp: number, endTimestamp: number): PriceRange | null => {
  // APY-5 Fix: Sort a copy so callers' arrays are not mutated.
  const sortedRecords = [...priceRecords].sort((a, b) => b.timestamp - a.timestamp);

  let earliestRecord: PriceRecord | null = null;
  let latestRecord: PriceRecord | null = null;

  for (const record of sortedRecords) {
    if (record.timestamp >= startTimestamp) {
      earliestRecord = record;
    }
    if (!latestRecord && record.timestamp <= endTimestamp) {
      latestRecord = record;
    }
    if (record.timestamp < startTimestamp) {
      break
    }
  }

  if (!earliestRecord || !latestRecord) {
    return null
  }

  if (earliestRecord.timestamp >= latestRecord.timestamp) {
    return null
  }

  return {
    startPrice: earliestRecord.price,
    endPrice: latestRecord.price,
    startTimestamp: earliestRecord.timestamp,
    endTimestamp: latestRecord.timestamp,
    startEpoch: earliestRecord.epoch,
    endEpoch: latestRecord.epoch,
  }
}

export const getPriceRangeFromDates = (priceRecords: PriceRecord[], start: Date, end: Date) => getPriceRange(priceRecords, Math.round(start.getTime() / 1e3), Math.round(end.getTime() / 1e3))

export const getPriceRangeFromPeriod = (priceRecords: PriceRecord[], periodSeconds = PERIOD.DAYS_30, end = new Date()) => getPriceRangeFromDates(priceRecords, new Date(end.getTime() - periodSeconds * 1e3), end)

export type Yield = { apy: number; apr: number }
export const calcYield = (priceRange: PriceRange): Yield => {
  if (priceRange.startPrice <= 0 || priceRange.endPrice <= 0) {
    throw new Error('Prices must be positive numbers!')
  }

  const deltaSeconds = priceRange.endTimestamp - priceRange.startTimestamp
  if (deltaSeconds <= 0) {
    throw new Error('Start timestamp must be before end timestamp!')
  }

  const periodYield = priceRange.endPrice / priceRange.startPrice
  const epochsPerPeriod = priceRange.endEpoch - priceRange.startEpoch
  
  // APY-3 Fix: Protect against division by zero (epochsPerPeriod <= 0)
  if (epochsPerPeriod <= 0) {
    throw new Error('At least 1 epoch must be in the range!')
  }

  const averageEpochDuration = deltaSeconds / epochsPerPeriod
  const epochsPerYear = SECONDS_PER.YEAR / averageEpochDuration
  const periodsPerYear = SECONDS_PER.YEAR / deltaSeconds

  const averageEpochRate = periodYield ** (1 / epochsPerPeriod) - 1

  const apy = (periodYield ** periodsPerYear) - 1
  const apr = averageEpochRate * epochsPerYear

  return {
    apy,
    apr,
  }
}