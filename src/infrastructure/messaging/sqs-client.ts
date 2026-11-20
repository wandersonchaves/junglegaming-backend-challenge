import { SQSClient } from '@aws-sdk/client-sqs';
import { AppConfig } from '../config/app-config';

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    // LocalStack accepts any credentials; the SDK still wants some.
    credentials:
      config.endpoint !== undefined
        ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        }
        : undefined,
  });
}
