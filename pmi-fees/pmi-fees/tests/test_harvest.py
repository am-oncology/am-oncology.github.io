"""Offline tests. Run: python -m tests.test_harvest"""
import io, json
from pathlib import Path
import openpyxl
from harvest import axa, vitality, run_all
from harvest.common import parse_fee_tables, parse_money

FIX = Path(__file__).parent / "fixtures"

def test_money():
    assert parse_money("£1,000.00") == 1000.0 and parse_money("125.00") == 125.0
    assert parse_money("3") is None and parse_money("Minor") is None and parse_money(250) == 250.0

def test_axa_index():
    links = axa.chapter_links((FIX / "axa_index.html").read_text(), "contracted")
    assert len(links) == 2 and all("source=contracted" in u for u, _ in links)
    assert "Chemotherapy" in links[0][1]

def test_axa_chapter():
    html = (FIX / "axa_chapter.html").read_text()
    rows = {r["code"]: r for r in parse_fee_tables(html)}
    assert set(rows) == {"X0001", "A5480", "X0005"}, rows.keys()
    assert rows["X0001"]["fee"] == 125.0 and rows["X0001"]["anaes"] == 0.0
    assert rows["X0001"]["unacceptable"] == ["X0002", "X0005"]
    assert rows["A5480"]["complexity"] == "Minor" and rows["A5480"]["unacceptable"] == ["A5530"]
    assert rows["X0005"]["fee"] == 1000.0 and rows["X0005"]["section"] == "18.0 - Chemotherapy"
    assert "all inclusive including consultations" in axa.chapter_note(html)

def make_xlsx():
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Surgical"
    ws.append(["Vitality fee finder"]); ws.append([])
    ws.append(["CCSD Code", "Procedure Description", "Complexity", "Old Fee", "Maximum Fee (£)", "Anaesthetist Fee"])
    ws.append(["X0001", "SACT supervision 0-7 days", "", 100, 130, 0])
    ws.append(["a5480", "Intrathecal chemotherapy", "Minor", "£90.00", "£105.00", None])
    ws.append(["Total", None, None, None, 999, None])
    buf = io.BytesIO(); wb.save(buf); return buf.getvalue()

def test_vitality():
    assert vitality.find_xlsx_link((FIX / "vitality_page.html").read_text()).endswith(".xlsx?rev=acd6")
    rows = {r["code"]: r for r in vitality.parse_workbook(make_xlsx())}
    assert set(rows) == {"X0001", "A5480"}
    assert rows["X0001"]["fee"] == 130.0 and rows["A5480"]["fee"] == 105.0 and rows["A5480"]["complexity"] == "Minor"

def rec(code, fee):
    return {"code": code, "description": f"desc {code}", "fee": fee, "anaes": 0.0, "complexity": "", "unacceptable": []}

def test_build_diff_and_guards():
    first, ch = run_all.build({}, {"axa_fa": ("ok", [rec("X0001", 125), rec("X0002", 250)], {"source_url": "u"})}, "T1")
    assert ch == [] and first["sources"]["axa_fa"]["status"] == "ok" and first["codes"]["X0001"]["fees"]["axa_fa"]["fee"] == 125
    second, ch = run_all.build(first, {"axa_fa": ("ok", [rec("X0001", 130), rec("X0003", 375)], {})}, "T2")
    kinds = {(c["code"], c["kind"]) for c in ch}
    assert kinds == {("X0001", "fee"), ("X0002", "removed"), ("X0003", "added")}, kinds
    third, ch = run_all.build(second, {"axa_fa": ("error", "boom", None)}, "T3")
    assert third["sources"]["axa_fa"]["status"] == "stale" and third["sources"]["axa_fa"]["last_success"] == "T2"
    assert third["codes"]["X0001"]["fees"]["axa_fa"]["fee"] == 130 and ch == []
    big = [rec(f"X{i:04d}", 100) for i in range(100)]
    fourth, _ = run_all.build({}, {"vitality": ("ok", big, {})}, "T4")
    fifth, _ = run_all.build(fourth, {"vitality": ("ok", big[:10], {})}, "T5")
    assert fifth["sources"]["vitality"]["status"] == "stale" and fifth["sources"]["vitality"]["count"] == 100
    sixth, _ = run_all.build(fifth, {}, "T6")  # sources not run carry forward
    assert sixth["sources"]["vitality"]["count"] == 100

def test_manual(tmp=Path("/tmp/bupa_test.csv")):
    tmp.write_text("code,fee,anaesthetist_fee,complexity,notes,checked_on\nX0001,140,,,,2026-10-01\nBAD,1,,,,\nA5480,£110.50,0,Minor,note,2026-09-01\n")
    rows = {r["code"]: r for r in run_all.read_manual(tmp)}
    assert rows["X0001"]["fee"] == 140.0 and rows["X0001"]["anaes"] is None and rows["X0001"]["as_of"] == "2026-10-01"
    assert rows["A5480"]["fee"] == 110.5 and "BAD" not in rows



# ---- added with the extra insurers -------------------------------------------
from harvest import freedom, browser  # noqa: E402
from harvest.common import parse_pdf, parse_pdf_lines, records_from_json, is_code  # noqa: E402


def test_codes():
    assert is_code("20300") and is_code("64300") and is_code("BT253") and is_code("IM269") and is_code("x0005")
    assert not is_code("01202") and not is_code("2015") and not is_code("12345")


def test_exeter_with_consultations():
    rows = {r["code"]: r for r in parse_fee_tables((FIX / "exeter_page.html").read_text())}
    assert rows["BT253"]["fee"] == 200.0 and rows["A5480"]["anaes"] == 0.0 and rows["20110"]["fee"] == 29.0
    assert rows["20300"]["fee"] == 175.0 and rows["20300"]["anaes"] is None
    assert "surgeon £130" in rows["20300"]["notes"] and "psychiatrist £180" in rows["20300"]["notes"]


def test_freedom_pdf():
    links = freedom.chapter_links((FIX / "freedom_index.html").read_text())
    assert [t for _, t in links] == ["Chapter 18 - Chemotherapy", "Chapter 20 - Radiotherapy (including brachytherapy)"]
    rows, note = parse_pdf((FIX / "freedom_ch18.pdf").read_bytes())
    rows = {r["code"]: r for r in rows}
    assert set(rows) == {"A5480", "X0001", "X0002", "X0005"}, rows.keys()
    assert rows["X0002"]["fee"] == 250.0 and "1-14 days" in rows["X0002"]["description"]
    assert rows["X0005"]["fee"] == 1000.0 and rows["X0005"]["section"].startswith("18.1")
    assert "consultation may be charged before treatment" in note and "Registered" not in note


def test_allianz_layouts():
    lines = ["Section 1 - Investigations", "1.3 Consultation Codes Surgeon", "Fee", "Physician", "Fee", "Psychiatrist", "Fee",
             "20300 Initial consultation £150 £170 £200",
             "3.1 Spinal Column (including Intervertebral", "Disc) Procedure", "Fee", "Anaesthetist", "Fee",
             "S5240", "Two or more injections into subcutaneous", "tissue under local anaesthetic", "£165 £130",
             "V2562 Decompression for central spinal stenosis (3 or £1,220 £470", "18", "more levels)",
             "A5790 Sacroiliac joint injection under image guidance £165 100",
             "V2560 £850 £370", "Decompression for central spinal stenosis (1 or 2", "levels)",
             "V2546 undercutting facetectomy +/- decompression -£950 £320",
             "Tel: 0203 564 2546", "01202 756 350"]
    rows = {r["code"]: r for r in parse_pdf_lines(lines)[0]}
    assert rows["20300"]["fee"] == 170.0, rows["20300"]
    assert rows["S5240"]["fee"] == 165.0 and rows["S5240"]["anaes"] == 130.0
    assert rows["V2562"]["fee"] == 1220.0 and rows["V2562"]["description"].endswith("more levels)")
    assert rows["A5790"]["anaes"] == 100.0
    assert rows["V2560"]["fee"] == 850.0 and "(1 or 2 levels)" in rows["V2560"]["description"]
    assert rows["V2546"]["fee"] == 950.0
    assert "01202" not in rows and len(rows) == 6


def test_json_records():
    payload = {"total": 2, "items": [
        {"CCSDCode": "X0003", "Description": "SACT supervision 1-21 days", "Notes": "One per course",
         "ProcedureFee": 375.0, "AnaestheticFee": -1, "HospitalComplexity": "Non",
         "UnacceptableCombinations": [{"CCSDCode": "X0001", "Description": "x"}, {"CCSDCode": "X0002"}]},
        {"code": "A5480", "desc": "Intrathecal chemotherapy", "surgeonFee": "£100.00", "anaesthetistFee": "0"},
        {"ChapterCode": "18", "Name": "Chemotherapy"}]}
    rows = {r["code"]: r for r in records_from_json(payload)}
    assert set(rows) == {"X0003", "A5480"}
    assert rows["X0003"]["fee"] == 375.0 and rows["X0003"]["anaes"] is None and rows["X0003"]["unacceptable"] == ["X0001", "X0002"]
    assert rows["X0003"]["complexity"] == "Non" and rows["X0003"]["notes"] == "One per course"
    assert rows["A5480"]["fee"] == 100.0 and rows["A5480"]["anaes"] == 0.0


def test_manual_discovery(tmp=Path("/tmp/manual_test")):
    import shutil
    shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
    (tmp / "bupa.csv").write_text("code,fee\n")
    (tmp / "cigna.csv").write_text("code,fee,anaesthetist_fee,complexity,notes,checked_on\nX0003,390,,,,2026-09-30\n")
    old = run_all.MANUAL_DIR
    run_all.MANUAL_DIR = tmp
    try:
        ids = [s["id"] for s in run_all.all_sources()]
        assert ids.count("bupa") == 1 and "cigna" in ids
        cig = next(s for s in run_all.all_sources() if s["id"] == "cigna")
        assert cig["insurer"] == "Cigna" and run_all.read_manual(cig["manual"])[0]["fee"] == 390.0
    finally:
        run_all.MANUAL_DIR = old


def test_browser_sites_configured():
    assert set(browser.SITES) == {"aviva", "wpa", "healix", "cshealthcare"}
    assert all(s in browser.STRATEGIES for cfg in browser.SITES.values() for s in cfg["strategies"])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok ", name)
