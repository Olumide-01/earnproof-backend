/* eslint-disable @typescript-eslint/no-unused-vars */
import { Injectable } from "@nestjs/common";

@Injectable()
export class RedisService {
  async get(_key: string): Promise<string | null> {
    return null;
  }

  async set(_key: string, _value: string, _mode?: string, _duration?: number): Promise<string> {
    return "OK";
  }

  async incr(_key: string): Promise<number> {
    return 1;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async del(_key: string): Promise<number> {
    return 1;
  }
}
