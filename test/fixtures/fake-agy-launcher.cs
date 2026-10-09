using System;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

// 供正式 stdio 包装测试使用，转发参数给已有假 CLI，不调用本机 agy。
public class Program {
    public static int Main(string[] args) {
        var script = Environment.GetEnvironmentVariable("PLUGIN_TEST_FAKE_SCRIPT");
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("PLUGIN_TEST_NODE"));
        info.Arguments = "\"" + script + "\" " + string.Join(" ", args.Select(a => Convert.ToBase64String(Encoding.UTF8.GetBytes(a))));
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        using (var child = Process.Start(info)) {
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
        }
    }
}
