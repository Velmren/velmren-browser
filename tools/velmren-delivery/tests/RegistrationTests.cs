using System.Text.Json;
using Velmren.Delivery;

var checks = new List<string>();
void Check(bool condition, string name)
{
    if (!condition) throw new Exception(name);
    checks.Add(name);
}
Dictionary<string, RegistrationValue> Plan(string version = "1.0.0.1") => new(StringComparer.OrdinalIgnoreCase) {
    ["VelmrenOwner"] = RegistrationValue.String("fixture-owner"),
    ["InstallLocation"] = RegistrationValue.String("C:\\fixture"),
    ["DisplayName"] = RegistrationValue.String("Velmren Fixture"),
    ["DisplayVersion"] = RegistrationValue.String(version),
    ["Publisher"] = RegistrationValue.String("Velmren"),
    ["DisplayIcon"] = RegistrationValue.String("C:\\fixture\\Velmren.exe"),
    ["UninstallString"] = RegistrationValue.String("C:\\fixture\\maintenance.exe --uninstall"),
    ["NoModify"] = RegistrationValue.Dword(1), ["NoRepair"] = RegistrationValue.Dword(1)
};
void Publish(MemoryStore store, Dictionary<string, RegistrationValue> desired, CancellationToken token = default)
{
    var previousPlan = store.Recorded;
    RegistrationWriter.Publish(store, "fixture", "fixture-owner", "C:\\fixture", desired, previousPlan,
        () => { store.Recorded = new(desired, StringComparer.OrdinalIgnoreCase); store.Tick("journal"); },
        () => { store.Complete = true; store.Tick("complete"); },
        () => { store.Recorded = previousPlan; store.Tick("restore-journal"); }, token);
}
bool Rejected(Action action)
{
    try { action(); return false; } catch (InvalidOperationException) { return true; }
}

var baseline = new MemoryStore(); Publish(baseline, Plan());
Check(baseline.Complete && baseline.Recorded is not null, "Successful registration retains its recovery plan");
Check(baseline.Trace.IndexOf("journal") < baseline.Trace.IndexOf("create"), "Journal precedes key creation");
Check(baseline.Trace[^2] == "set:DisplayName", "DisplayName is published last");
var mutations = baseline.Steps;
for (var cut = 1; cut <= mutations; cut++)
{
    var store = new MemoryStore { CrashAt = cut };
    try { Publish(store, Plan()); } catch (SimulatedCrash) { }
    store.CrashAt = null; Publish(store, Plan());
    Check(store.Complete && Plan().All(p => store.Data!.Values.GetValueOrDefault(p.Key) == p.Value), $"Recovery after durable boundary {cut}");
}
for (var cut = 1; cut <= mutations; cut++)
{
    var store = new MemoryStore(); using var cancellation = new CancellationTokenSource();
    store.AfterMutation = s => { if (s.Steps == cut) cancellation.Cancel(); };
    try { Publish(store, Plan(), cancellation.Token); } catch (OperationCanceledException) { }
    store.AfterMutation = null; Publish(store, Plan());
    Check(store.Complete && store.Data!.Values.Count == Plan().Count, $"Cancellation is resumable at boundary {cut}");
}
var alreadyCancelled = new MemoryStore(); using (var cancellation = new CancellationTokenSource())
{
    cancellation.Cancel(); try { Publish(alreadyCancelled, Plan(), cancellation.Token); } catch (OperationCanceledException) { }
}
Check(alreadyCancelled.Steps == 0, "Pre-cancelled work makes no changes");

var emptyForeign = new MemoryStore { Data = new() };
Check(Rejected(() => Publish(emptyForeign, Plan())) && emptyForeign.Steps == 0, "Unjournaled empty foreign key is refused");
var foreignOwner = new MemoryStore { Data = new() };
foreignOwner.Data.Values["VelmrenOwner"] = RegistrationValue.String("other-owner");
Check(Rejected(() => Publish(foreignOwner, Plan())) && foreignOwner.Steps == 0, "Another owner is refused without changes");
var collision = new MemoryStore { Race = new() };
Check(Rejected(() => Publish(collision, Plan())) && collision.Recorded is null && collision.Data!.Values.Count == 0,
    "Concurrent foreign creation is rejected and its new recovery authorization is revoked");
Check(Rejected(() => Publish(collision, Plan())), "Retry does not adopt a previously rejected concurrent key");

foreach (var invalid in new[] { "unknown value", "wrong expected value", "wrong type", "subkey", "wrong identity" })
{
    var store = new MemoryStore { Data = new(), Recorded = Plan() };
    if (invalid == "unknown value") store.Data.Values["UserData"] = RegistrationValue.String("keep");
    if (invalid == "wrong expected value") store.Data.Values["DisplayName"] = RegistrationValue.String("other product");
    if (invalid == "wrong type") store.Data.Values["NoModify"] = RegistrationValue.String("1");
    if (invalid == "subkey") store.Data.SubKeys = 1;
    if (invalid == "wrong identity") store.Data.Values["VelmrenOwner"] = RegistrationValue.String("other-owner");
    Check(Rejected(() => Publish(store, Plan())) && store.Steps == 0, "Partial recovery rejects " + invalid);
}
var owned = new MemoryStore { Data = new() };
owned.Data.Values = Plan(); owned.Data.Values["UserData"] = RegistrationValue.String("keep"); owned.Data.SubKeys = 1;
Publish(owned, Plan("1.0.0.2"));
Check(owned.Data.Values["UserData"].Text == "keep" && owned.Data.SubKeys == 1, "Updating an owned key preserves unrelated values and subkeys");

var diskLag = new MemoryStore(); Publish(diskLag, Plan()); diskLag.Data = new();
Publish(diskLag, Plan());
Check(diskLag.Complete && diskLag.Data.Values.Count == Plan().Count, "A retained plan repairs an empty key after registry lazy-write loss");
for (var cut = 1; cut <= mutations + 2; cut++)
{
    var store = new MemoryStore { Data = new(), Recorded = Plan(), CrashAt = cut };
    store.Data.Values["DisplayVersion"] = Plan()["DisplayVersion"];
    try { Publish(store, Plan("1.0.0.2")); } catch (SimulatedCrash) { }
    store.CrashAt = null; Publish(store, Plan("1.0.0.2"));
    Check(store.Data.Values["DisplayVersion"].Text == "1.0.0.2", $"Partial old-plan recovery into newer plan at boundary {cut}");
}
for (var cut = 1; cut < mutations; cut++)
{
    var store = new MemoryStore(); Publish(store, Plan()); store.Steps = 0; store.CrashAt = cut;
    try { Publish(store, Plan("1.0.0.2")); } catch (SimulatedCrash) { }
    store.CrashAt = null; Publish(store, Plan("1.0.0.2"));
    Check(store.Data!.Values["DisplayVersion"].Text == "1.0.0.2", $"Owned update recovery at boundary {cut}");
}
void Remove(MemoryStore store) => RegistrationWriter.Remove(store, "fixture", "fixture-owner", "C:\\fixture", store.Recorded, Plan().Keys, default);
var removable = new MemoryStore(); Publish(removable, Plan()); removable.Trace.Clear(); Remove(removable);
Check(removable.Data is null && removable.Trace.SequenceEqual(new[] { "delete-key" }), "Removal deletes wholly owned key without first erasing identity");
for (var cut = 1; cut <= Plan().Count - 2; cut++)
{
    var store = new MemoryStore(); Publish(store, Plan()); store.Data!.Values["UserData"] = RegistrationValue.String("keep"); store.Data.SubKeys = 1;
    store.Steps = 0; store.CrashAt = cut;
    try { Remove(store); } catch (SimulatedCrash) { }
    store.CrashAt = null; Remove(store);
    Check(store.Data.Values.Count == 3 && store.Data.Values["UserData"].Text == "keep" && store.Data.SubKeys == 1
        && store.Data.Values["VelmrenOwner"] == Plan()["VelmrenOwner"] && !store.Data.Values.ContainsKey("DisplayName"),
        $"Interrupted removal retains foreign data and ownership at boundary {cut}");
}
var partialRemoval = new MemoryStore { Data = new(), Recorded = Plan() };
partialRemoval.Data.Values["DisplayVersion"] = Plan()["DisplayVersion"]; Remove(partialRemoval);
Check(partialRemoval.Data is null, "Journaled partial registration can be rolled back");
var unknownRemoval = new MemoryStore { Data = new() }; unknownRemoval.Data.Values["UserData"] = RegistrationValue.String("keep");
Check(Rejected(() => Remove(unknownRemoval)) && unknownRemoval.Data.Values.Count == 1, "Removal refuses unowned registry data");
Console.WriteLine(JsonSerializer.Serialize(new { passed = true, count = checks.Count,
    registryAccess = "none; only RegistrationWriter.cs and this in-memory fixture are compiled", checks }, new JsonSerializerOptions { WriteIndented = true }));

sealed class SimulatedCrash : Exception { }
sealed class MemoryData
{
    internal Dictionary<string, RegistrationValue> Values = new(StringComparer.OrdinalIgnoreCase);
    internal int SubKeys;
}
sealed class MemoryStore : IRegistrationStore
{
    internal MemoryData? Data, Race;
    internal Dictionary<string, RegistrationValue>? Recorded;
    internal bool Complete;
    internal int Steps;
    internal int? CrashAt;
    internal Action<MemoryStore>? AfterMutation;
    internal List<string> Trace = [];
    internal void Tick(string operation)
    {
        Steps++; Trace.Add(operation); AfterMutation?.Invoke(this);
        if (CrashAt == Steps) throw new SimulatedCrash();
    }
    public IRegistrationKey? Open(string path) => Data is null ? null : new MemoryKey(this, Data);
    public (IRegistrationKey Key, bool Created) Create(string path)
    {
        if (Race is not null) { Data = Race; Race = null; return (new MemoryKey(this, Data), false); }
        Data = new(); Tick("create"); return (new MemoryKey(this, Data), true);
    }
    public void Delete(string path) { Data = null; Tick("delete-key"); }
    sealed class MemoryKey(MemoryStore store, MemoryData data) : IRegistrationKey
    {
        public RegistrationSnapshot Snapshot() => new(new(data.Values, StringComparer.OrdinalIgnoreCase), data.SubKeys);
        public void Set(string name, RegistrationValue value) { data.Values[name] = value; store.Tick("set:" + name); }
        public void DeleteValue(string name) { data.Values.Remove(name); store.Tick("delete:" + name); }
        public void Dispose() { }
    }
}
