// Copyright (c) 2026 The Brave Authors. All rights reserved.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this file,
// You can obtain one at https://mozilla.org/MPL/2.0/.

import * as React from 'react'

interface Engine {
  keyword: string
  host: string
  isDefault: boolean
}

// Follow the browser default; explicit alternatives last only for this tab.
export function useSearchEngineSelection<T extends Engine>(
  engines: T[],
  enabled: (host: string) => boolean,
) {
  const defaultEngine = engines.find((engine) => engine.isDefault) ?? engines[0]
  const [override, setOverride] = React.useState<string | null>(null)
  const previousDefault = React.useRef(defaultEngine?.keyword)
  const defaultChanged = previousDefault.current !== defaultEngine?.keyword
  const options = engines.filter(
    (engine) => engine === defaultEngine || enabled(engine.host),
  )
  const selected = options.find((entry) => entry.keyword === override)
  const engine = (!defaultChanged && selected) || defaultEngine

  React.useEffect(() => {
    if (defaultChanged || (override !== null && !selected)) {
      previousDefault.current = defaultEngine?.keyword
      setOverride(null)
    }
  }, [defaultEngine?.keyword, override, selected])

  return {
    engine,
    options,
    selectEngine(selected: T) {
      setOverride(
        selected.keyword === defaultEngine?.keyword ? null : selected.keyword,
      )
    },
  }
}
