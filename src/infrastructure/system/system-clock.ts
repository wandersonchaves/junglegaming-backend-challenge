import { randomUUID } from 'node:crypto';
import { Clock, IdGenerator } from '../../application/ports/clock-and-ids';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomUuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
