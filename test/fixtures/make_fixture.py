from openpyxl import Workbook
from openpyxl import load_workbook
import os

path = os.path.join("test", "fixtures", "calibration.xlsx")
wb = Workbook()
ws = wb.active
ws.title = "Cal"
ws.append(["Absorbance", "Dose (Gy)"])
for a, d in [(0.100, 10.0), (0.200, 25.5), (0.300, 41.0), (0.400, 60.2)]:
    ws.append([a, d])
wb.save(path)
print("wrote", path, os.path.getsize(path), "bytes")

wb2 = load_workbook(path)
print("verify:", list(wb2["Cal"].values))
