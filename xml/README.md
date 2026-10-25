# xml

An XML parser, serializer and query engine **written in Thrax**, built on
algebraic effects with multi-shot continuations. The parser is the point of the
exercise: it manages no control flow by hand, and every piece of control it
needs (where the cursor is, what to try next, how to give up) is an effect that a
handler supplies.

```
thrax check MAIN.thx            # the test suite: the checks run at compile time
thrax run MAIN.thx sample.xml   # the demo
thrax run -- sample.xml         # the same, letting the root be inferred
thrax build MAIN.thx            # a native binary in thrax-out/
```

`thrax run sample.xml` is NOT the same thing: the driver takes a first argument
that names an existing file as the root source and tries to compile it. `--`
says the root is not named here.

## The surface

```thrax
$ with XML

$ doc : Node = is parse src | Parsed.Ok.{ n } => n | _ => ...

$ titles : @Vec Node = find_all "title" doc
$ english : @Vec Node = find_where "book" "lang" "en" doc
$ first_title : Option @Str = text_at "title" doc
$ nested : @Vec Node = find_path ["library", "book", "title"] doc
$ back : @Str = render doc
```

| | |
| --- | --- |
| `parse : @Str -> Parsed Node` | a whole document, root element returned |
| `parse_fragment : @Str -> Parsed (@Vec Node)` | top-level nodes, no single root |
| `render : Node -> @Str` | serialize, escaping text and attribute values |
| `tag`, `attrs`, `attr`, `attr_or`, `kids`, `kid_count`, `elements`, `text_of`, `is_elem` | read a node |
| `find_all`, `find_one`, `find_where`, `find_path`, `text_at` | ready-made queries |
| `report`, `show_error` | render a failure |
| `matches`, `match_first` | run a query of your own |
| `child`, `descendant`, `anywhere`, `tagged`, `with_attr`, `no_match` | the pieces to write one from |

Entities (`&lt;` `&gt;` `&amp;` `&quot;` `&apos;` `&#60;` `&#x3c;`) are decoded on
the way in and escaped on the way out. Comments and processing instructions are
kept as nodes; CDATA becomes text, so it re-renders escaped rather than as
CDATA. Numeric references outside the single-byte range are left alone, because
a Thrax string is a byte vector and this library does not encode UTF-8 yet.

## The design

Four effects, and nothing else, carry the parser:

```thrax
$ Scan   : @effect = view : {} -> View, bump : @Int -> {},
$ Choice : @effect = fork : {} -> @Bool,
$ Soft   : @effect = reject : Err -> a,
$ Hard   : @effect = fatal : Err -> a,
```

**The cursor is a handler's parameter.** `view` reports the input and the offset
reached in it; `bump` advances. There is deliberately **no seek**: no grammar
function can move the cursor backwards, so rewinding cannot be hand-rolled.

**An alternative is a `fork`.** `alt p q` performs `fork {}` and runs `p` or `q`
by the answer. The handler resumes the *same* continuation twice, once per
branch, which is why this is backtracking rather than alternation: the
continuation is the whole rest of the parse, so a failure arriving long after the
branch comes back and takes the other way. And because each resumed branch runs
on its own copy of the captured computation, which still holds the position it
had at the fork, **the cursor rewinds itself**. That is the one thing to take
from this library: the parser never saves or restores a position, and never
needs to.

```thrax
$ element : {} -> <Scan, Choice, Soft, Hard> Node = \u =
	(lit "<" {} ;
	 let n = xml_name {} in
	 let a = attr_list (@vec_new {}) {} in
	 (skip_space {} ; alt (empty_tag n a) (open_tag n a)))
```

`empty_tag` assumes `<tag/>`; when `/>` is not there it rejects, and the handler
takes `open_tag`. Neither branch knows the other exists.

**Two kinds of failure.** `reject` is retried by the nearest choice point;
`fatal` is not. An alternative raises `fatal` once it has consumed the prefix
that commits it, so `<!-- x` reports an unterminated comment rather than
quietly being re-read as text. When every branch rejects, the failure that got
**furthest** through the input is the one reported, which is the message a reader
of a broken document wants.

**`commit` cuts.** Each piece of markup is parsed under its own choice handler
over its own cursor, and the enclosing cursor is then moved over what was
consumed. So backtracking is total *within* one item and absent *between* items:
the search a long document retains is one item's worth rather than the whole
file's.

### The query engine is the same effect, read differently

`fork` and a `Pick` effect (`one_of : List Node -> Node`) are all a path
expression needs. Write the query as straight-line code and let the handler
decide what "all the answers" means: `matches` resumes every branch and collects
every outcome, `match_first` resumes until one survives.

```thrax
$ by_hacker : @Vec @Str = matches <| \u =
	let b = tagged "book" (anywhere root) in
	let a = tagged "author" (child b) in
	if text_of a == "A. Hacker" => unwrap_or (text_at "title" b) "" else no_match {}
```

`anywhere` forks between "this node" and "something under it"; `child` picks a
child nondeterministically; `no_match` prunes the branch it is in. One handler
turns that into every match, and the cost is proportional to the matches rather
than to the tree.

## Diagnostics

A failure is an `Err` carrying an offset, a headline, the expectations that tied
there, and a note. `report file src err` renders it the way the compiler renders
its own errors:

```
error: expected a tag name after `<`
  --> sample.xml:13:2
   | <    <tags><tag>effects</tag></tags>
   |  ^
note: found a space; a literal `<` in text must be written `&lt;`
```

Three things make these readable rather than merely accurate:

- **What was expected, in XML's vocabulary**, not the grammar's. A rejection
  carries a phrase a person writing XML would recognise ("a quoted value for
  the attribute `k`"), and when several alternatives fail at the same offset their
  expectations are reported together rather than whichever was tried last.
- **The place an element opened.** A mismatched or missing closing tag is useless
  without it, so `element` carries its own `<` offset down into the failure:
  `` note: `<b>` opened at 2:1 ``.
- **What is actually there.** An expectation failure appends `found a space`,
  `` found `v` ``, `found the end of the input`. A failure with its own headline
  does not, since the caret already shows it.

The furthest failure wins, which is what makes the branch a document most nearly
matched the one that gets reported.

## Costs, measured

On the native backend (`thrax build`), parsing is **linear** in the input: 23KB
in 0.85s, 92KB in 4.0s, 185KB in 10.1s.

The interesting part is what that time is *not* spent on. A variant of this
parser with the alternation replaced by deterministic lookahead, and the
`/>` fork replaced by a peek, runs at the **same speed** (within noise). The
backtracking machinery is not what costs, and the cursor handlers' continuations
move rather than copy (each is resumed once, by its only owner). A callgrind
profile puts the time in the runtime instead:

| | share of instructions |
| --- | --- |
| `strcmp` (global lookup by name) | 28% |
| `THxRT_glob` | 7% |
| `calloc` / `memset` / `free` / refcounting | ~30% |

So the library is a useful measurement of the *runtime*, not of the technique:
every reference to a top-level function resolves through a linear chain of
`strcmp` in the generated C, and every value is a heap allocation. Neither is
inherent to effect-based parsing.

What *is* inherent, and worth knowing before using this style elsewhere: a
captured continuation holds its slice of the parse until the choice point that
owns it is resolved, so backtracking that is never cut retains the search tree.
That is what `commit` is for.

## Files

| | |
| --- | --- |
| `XML.thx` | the library. Public surface above `$ @private`, grammar and handlers below |
| `MAIN.thx` | the test suite (compile-time `assert`s) and the demo entry point |
| `BENCH.thx` | parse-only timing harness |
| `sample.xml` | the demo document |
