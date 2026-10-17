import "./setup"
import { afterEach, describe, expect, test } from "bun:test"
import { dataDir, resolveDataPath } from "../src/utils/paths"

describe("data dir resolution", () => {
  afterEach(() => {
    delete process.env.CHITCHAT_DATA_DIR
  })

  test("defaults to the current working directory", () => {
    delete process.env.CHITCHAT_DATA_DIR
    expect(dataDir()).toBe(process.cwd())
  })

  test("honours CHITCHAT_DATA_DIR when set", () => {
    process.env.CHITCHAT_DATA_DIR = "/tmp/chitchat-data-test"
    expect(dataDir()).toBe("/tmp/chitchat-data-test")
    expect(resolveDataPath(".media-cache")).toBe("/tmp/chitchat-data-test/.media-cache")
  })

  test("ignores a blank override", () => {
    process.env.CHITCHAT_DATA_DIR = "   "
    expect(dataDir()).toBe(process.cwd())
  })
})
