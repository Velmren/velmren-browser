/* Copyright (c) 2026 The Velmren Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CONTENT_RENDERER_PASSWORD_AUTOFILL_AGENT_H_
#define BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CONTENT_RENDERER_PASSWORD_AUTOFILL_AGENT_H_

#include "base/containers/flat_set.h"
#include "build/build_config.h"
#include "components/autofill/core/common/unique_ids.h"

#if BUILDFLAG(IS_WIN)
// IDs only: a rejected edit invalidates a previously reported candidate without
// forwarding short/oversize values or retaining copies of usernames.
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_FIELDS \
  base::flat_set<FieldRendererId> username_first_reported_fields_;
#else
#define BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_FIELDS
#endif

#include <components/autofill/content/renderer/password_autofill_agent.h>  // IWYU pragma: export

#undef BRAVE_PASSWORD_AUTOFILL_AGENT_USERNAME_FIRST_FIELDS

#endif  // BRAVE_CHROMIUM_SRC_COMPONENTS_AUTOFILL_CONTENT_RENDERER_PASSWORD_AUTOFILL_AGENT_H_
