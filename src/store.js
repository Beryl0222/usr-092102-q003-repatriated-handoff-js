import { randomUUID } from "node:crypto";
import { existsSync, appendFileSync, readFileSync } from "node:fs";

import { validateEvent } from "./validator.js";

export class ConcurrencyError extends Error {
  constructor(aggregateType, aggregateId, expected, actual) {
    super(
      `聚合 ${aggregateType}/${aggregateId} 版本冲突：期望版本 ${expected}，流上已有 ${actual} 个事件`,
    );
    this.name = "ConcurrencyError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class DuplicateRequestError extends Error {
  constructor(requestId, existingEventId) {
    super(`request_id=${requestId} 已处理，对应事件 ${existingEventId}`);
    this.name = "DuplicateRequestError";
    this.existingEventId = existingEventId;
  }
}

export const streamKey = (aggregateType, aggregateId) =>
  `${aggregateType}/${aggregateId}`;

/**
 * 事件存储：按聚合流维护单调版本号，按 request_id 维护命令幂等索引。
 * 同一 request_id 的重复提交（离线扫码补传、重复报关消息）只返回首次事件，
 * 绝不产生第二次占有变更。
 */
export class EventStore {
  /** @type {Map<string, object[]>} key = aggregate_type/aggregate_id */
  #streams = new Map();
  /** request_id → 已落库事件 */
  #requestIndex = new Map();
  #eventIds = new Set();

  /**
   * @param {object} event 已带 version 的待落库事件
   * @param {{expectedVersion?: number, requestId?: string}} [opts]
   * @returns {{event: object, replayed: boolean}} replayed=true 表示命中幂等索引，未产生新事件
   */
  append(event, opts = {}) {
    // 事件信封自带 request_id 时（如 JSONL 重放）同样进入幂等索引。
    const requestId = opts.requestId ?? event.request_id;
    const { expectedVersion } = opts;

    if (requestId) {
      const existing = this.#requestIndex.get(requestId);
      if (existing) return { event: existing, replayed: true };
    }
    if (this.#eventIds.has(event.event_id)) {
      throw new DuplicateRequestError(requestId ?? "(event_id)", event.event_id);
    }

    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件校验失败：${errors.join("；")}`);

    const key = streamKey(event.aggregate_type, event.aggregate_id);
    const stream = this.#streams.get(key) ?? [];
    if (event.version !== stream.length + 1) {
      throw new ConcurrencyError(
        event.aggregate_type,
        event.aggregate_id,
        event.version,
        stream.length,
      );
    }
    if (expectedVersion !== undefined && expectedVersion !== stream.length) {
      throw new ConcurrencyError(
        event.aggregate_type,
        event.aggregate_id,
        expectedVersion,
        stream.length,
      );
    }

    const stored = Object.freeze({ ...event });
    stream.push(stored);
    this.#streams.set(key, stream);
    this.#eventIds.add(stored.event_id);
    if (requestId) this.#requestIndex.set(requestId, stored);
    return { event: stored, replayed: false };
  }

  /** 同一命令重放时，调用方可据此判断“本次没有产生新事件”。 */
  hasRequest(requestId) {
    return this.#requestIndex.has(requestId);
  }

  getByRequest(requestId) {
    return this.#requestIndex.get(requestId);
  }

  stream(aggregateType, aggregateId) {
    return [...(this.#streams.get(streamKey(aggregateType, aggregateId)) ?? [])];
  }

  versionOf(aggregateType, aggregateId) {
    return (this.#streams.get(streamKey(aggregateType, aggregateId)) ?? []).length;
  }

  allEvents() {
    return [...this.#streams.values()]
      .flat()
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  }

  /** 跨流查询：报关消息号等业务去重键。 */
  findEvent(predicate) {
    for (const events of this.#streams.values()) {
      const hit = events.find(predicate);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** JSONL 持久化的事件存储：启动时重放，追加新事件时同步落盘；幂等重放不重复写盘。 */
export class JsonlEventStore extends EventStore {
  #file;

  constructor(file) {
    super();
    this.#file = file;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) super.append(JSON.parse(line));
      }
    }
  }

  append(event, opts = {}) {
    const result = super.append(event, opts);
    if (this.#file && !result.replayed) {
      appendFileSync(this.#file, `${JSON.stringify(result.event)}\n`);
    }
    return result;
  }
}

let eventCounter = 0;
/** 生成可读的事件标识；同一毫秒内以进程内计数器去重。 */
export function newEventId(prefix = "evt") {
  eventCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${eventCounter}-${randomUUID().slice(0, 8)}`;
}
