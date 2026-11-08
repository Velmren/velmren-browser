/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react'
import { SearchEngineMenu } from '$web-common/SearchEngineMenu'

import { getString } from '../../lib/strings'
import { SearchEngineInfo } from '../../state/search_store'
import { EngineIcon } from './engine_icon'

interface Props {
  selectedEngine: SearchEngineInfo | null
  searchEngines: SearchEngineInfo[]
  onSelectEngine: (engine: SearchEngineInfo) => void
  onCustomizeClick: () => void
}

export function SearchEnginePicker(props: Props) {
  return (
    <SearchEngineMenu
      engines={props.searchEngines}
      selectedEngine={props.selectedEngine}
      engineKey={(engine) => engine.keyword}
      engineName={(engine) =>
        engine.isDefault
          ? `${engine.name} (${getString(S.NEW_TAB_SEARCH_BROWSER_DEFAULT_LABEL)})`
          : engine.name
      }
      renderIcon={(engine) => <EngineIcon engine={engine} />}
      label={`${getString(S.NEW_TAB_SEARCH_ENGINE_PICKER_LABEL)}: ${props.selectedEngine?.name ?? ''}`}
      description={getString(S.NEW_TAB_SEARCH_ENGINE_SCOPE_DESCRIPTION)}
      customizeLabel={getString(S.NEW_TAB_SEARCH_CUSTOMIZE_ENGINE_LIST_TEXT)}
      browserDefaultLabel={getString(S.NEW_TAB_SEARCH_BROWSER_DEFAULT_LINK)}
      onSelectEngine={props.onSelectEngine}
      onCustomizeClick={props.onCustomizeClick}
    />
  )
}
