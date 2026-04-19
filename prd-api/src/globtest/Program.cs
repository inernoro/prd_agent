using System;
using Microsoft.Extensions.FileSystemGlobbing;

class Program {
    static void Main() {
        var m = new Matcher();
        m.AddInclude("report*.md");
        
        string name1 = "design.account-data-sharing.md";
        string name2 = "report.2023.md";
        string name3 = "report_test.md";

        Console.WriteLine($"report*.md vs {name1} -> " + m.Match(name1).HasMatches);
        Console.WriteLine($"report*.md vs {name2} -> " + m.Match(name2).HasMatches);
        Console.WriteLine($"report*.md vs {name3} -> " + m.Match(name3).HasMatches);
        
        var m2 = new Matcher();
        m2.AddInclude("report.*.md");
        Console.WriteLine($"report.*.md vs {name1} -> " + m2.Match(name1).HasMatches);
        Console.WriteLine($"report.*.md vs {name2} -> " + m2.Match(name2).HasMatches);
        Console.WriteLine($"report.*.md vs {name3} -> " + m2.Match(name3).HasMatches);
    }
}
