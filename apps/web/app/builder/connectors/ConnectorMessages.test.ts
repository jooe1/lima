import { describe, expect, it } from 'vitest'
import enMessages from '../../../messages/en.json'
import deMessages from '../../../messages/de.json'

describe('connector locale messages', () => {
  it('defines the detail namespace in English and German', () => {
    expect(enMessages.connectors.detail).toMatchObject({
      title: expect.any(String),
      section1: expect.any(String),
      section2: expect.any(String),
      section3: expect.any(String),
      section4: expect.any(String),
      section5: expect.any(String),
      showTips: expect.any(String),
      loadingColumns: expect.any(String),
      loadingActions: expect.any(String),
      addAction: expect.any(String),
      noSchema: expect.any(String),
      refreshSchema: expect.any(String),
      saveSettings: expect.any(String),
      testConnection: expect.any(String),
      testOk: expect.any(String),
      testFail: expect.any(String),
    })

    expect(deMessages.connectors.detail).toMatchObject({
      title: expect.any(String),
      section1: expect.any(String),
      section2: expect.any(String),
      section3: expect.any(String),
      section4: expect.any(String),
      section5: expect.any(String),
      showTips: expect.any(String),
      loadingColumns: expect.any(String),
      loadingActions: expect.any(String),
      addAction: expect.any(String),
      noSchema: expect.any(String),
      refreshSchema: expect.any(String),
      saveSettings: expect.any(String),
      testConnection: expect.any(String),
      testOk: expect.any(String),
      testFail: expect.any(String),
    })
  })
})