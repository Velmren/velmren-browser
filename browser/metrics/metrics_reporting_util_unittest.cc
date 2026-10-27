/* Copyright (c) 2021 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "brave/browser/metrics/metrics_reporting_util.h"

#include "brave/browser/metrics/buildflags/buildflags.h"
#include "chrome/test/base/testing_browser_process.h"
#include "components/metrics/metrics_pref_names.h"
#include "components/prefs/pref_service.h"
#include "testing/gtest/include/gtest/gtest.h"

TEST(MetricsUtilTest, ReportingDefaultsOff) {
  EXPECT_FALSE(GetDefaultPrefValueForMetricsReporting());
}

TEST(MetricsUtilTest, CrashReportPermissionDialogSuppressedRegardlessOfOptIn) {
#if BUILDFLAG(ENABLE_CRASH_DIALOG)
  const bool reporting_enabled = g_browser_process->local_state()->GetBoolean(
      metrics::prefs::kMetricsReportingEnabled);
  g_browser_process->local_state()->SetBoolean(
      metrics::prefs::kMetricsReportingEnabled, false);
  EXPECT_FALSE(ShouldShowCrashReportPermissionAskDialog());

  g_browser_process->local_state()->SetBoolean(
      metrics::prefs::kMetricsReportingEnabled, true);
  EXPECT_FALSE(ShouldShowCrashReportPermissionAskDialog());

  g_browser_process->local_state()->SetBoolean(
      metrics::prefs::kMetricsReportingEnabled, reporting_enabled);
#else
  EXPECT_FALSE(ShouldShowCrashReportPermissionAskDialog());
#endif
}
