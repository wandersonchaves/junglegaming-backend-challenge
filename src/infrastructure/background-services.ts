import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { BACKGROUND_TASKS } from './tokens';

export interface BackgroundTask {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Starts the SQS consumer and the workers with the application and stops them on shutdown
 * (SIGTERM): polling ends, work in progress finishes, then the database closes.
 */
@Injectable()
export class BackgroundServices implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(BACKGROUND_TASKS) private readonly tasks: BackgroundTask[]) { }

  onApplicationBootstrap(): void {
    for (const task of this.tasks) task.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.tasks.map((task) => task.stop()));
  }
}
