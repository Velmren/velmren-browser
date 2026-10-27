/* Copyright (c) 2019 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/browser/metrics/metrics_reporting_util.h"

#include "brave/browser/metrics/brave_metrics_service_accessor.h"
#include "brave/browser/metrics/buildflags/buildflags.h"
#include "brave/components/constants/pref_names.h"
#include "brave/components/velmren/product_policy.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/metrics/metrics_reporting_state.h"
#include "components/prefs/pref_service.h"

bool GetDefaultPrefValueForMetricsReporting() {
  return velmren::kTelemetryEnabled;
}

bool ShouldShowCrashReportPermissionAskDialog() {
  if (!velmren::kTelemetryEnabled) {
    return false;
  }
#if BUILDFLAG(ENABLE_CRASH_DIALOG)
  PrefService* local_prefs = g_browser_process->local_state();
  if (local_prefs->GetBoolean(kDontAskForCrashReporting)) {
    return false;
  }

  if (metrics::IsMetricsReportingPolicyManaged()) {
    return false;
  }

  if (BraveMetricsServiceAccessor::IsMetricsAndCrashReportingEnabled()) {
    return false;
  }

  return true;
#else
  return false;
#endif
}
