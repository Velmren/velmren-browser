/* Copyright (c) 2026 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_HIDDEN_TARGET_MANAGER_H_
#define BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_HIDDEN_TARGET_MANAGER_H_

#include <map>

#include "base/containers/unique_ptr_adapters.h"
#include "base/memory/weak_ptr.h"
#include "content/browser/devtools/protocol/protocol.h"
#include "content/public/browser/web_contents_delegate.h"

// Shown targets remain owned by this protocol session, but the tab strip owns
// their WebContents while the human is using them. Weak references handle a
// human closing a handed-off tab before the session resumes it.
#define Clear                                                             \
  ClearVisibleTargets();                                                  \
  Response SetTargetVisibility(const std::string& target_id, bool visible); \
  private:                                                                \
  std::map<std::string, base::WeakPtr<content::WebContents>>                 \
      visible_web_contents_;                                              \
  public:                                                                 \
  void Clear

#include <content/browser/devtools/protocol/hidden_target_manager.h>  // IWYU pragma: export

#undef Clear

#endif  // BRAVE_CHROMIUM_SRC_CONTENT_BROWSER_DEVTOOLS_PROTOCOL_HIDDEN_TARGET_MANAGER_H_
