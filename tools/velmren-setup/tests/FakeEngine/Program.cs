using System.Text;
using System.Text.Json;

Console.OutputEncoding = Encoding.UTF8;
Console.InputEncoding = Encoding.UTF8;
var command = args[0];
var options = new Dictionary<string, string>();
for (var index = 1; index < args.Length; index += 2) options.Add(args[index], args[index + 1]);
var root = options["--root"];
Directory.CreateDirectory(root);
await File.WriteAllTextAsync(Path.Combine(root, "arguments-" + command + ".json"), JsonSerializer.Serialize(args));
switch (command)
{
    case "install":
    case "install-bundle":
        Console.WriteLine("Not an event");
        Console.WriteLine(JsonSerializer.Serialize(new { action = "phase-started", phase = "extract-files", elapsedMs = 0, version = "1.0.0.0" }));
        foreach (var percent in new[] { 10, 55, 100 })
        {
            Console.WriteLine(JsonSerializer.Serialize(new { action = "extracting", percent, completed = percent * 100000000L, total = 10000000000L }));
            await Task.Delay(40);
        }
        Console.WriteLine(JsonSerializer.Serialize(new { action = "phase-completed", phase = "extract-files", elapsedMs = 120, version = "1.0.0.0", bytes = 10000000000L, files = 42, succeeded = true }));
        break;
    case "register": Console.WriteLine("{\"action\":\"registered\"}"); break;
    case "uninstall": Console.WriteLine("{\"action\":\"uninstalled\"}"); break;
    case "fail":
        await Console.Error.WriteAsync("InvalidDataException: https://private.example/manifest.json signature rejected " + new string('x', 20000));
        return 1;
    case "wait":
        Console.WriteLine("{\"action\":\"downloading\"}");
        while (!File.Exists(options["--cancel-file"])) await Task.Delay(20);
        await File.WriteAllTextAsync(Path.Combine(root, "cancelled.txt"), "graceful");
        return 130;
    case "ignore-cancel":
        await Task.Delay(TimeSpan.FromSeconds(45));
        break;
    default: return 2;
}
return 0;
