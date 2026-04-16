# Requirements Knowledge Base

Web app để quản lý requirements, phát hiện conflict, truy vết và xem dashboard.

## Cách dùng nhanh

### 1) Clone project

```powershell
git clone https://github.com/vinh3123410433/C-ng-ngh-tri-th-c.git
cd C-ng-ngh-tri-th-c
```

### 2) Cài dependency

```powershell
C:/Users/vinh/AppData/Local/Programs/Python/Python311/python.exe -m pip install -r server/requirements.txt
```

### 3) Chạy ứng dụng

```powershell
Set-Location "d:/Công nghệ tri thức/server"
C:/Users/vinh/AppData/Local/Programs/Python/Python311/python.exe app.py
```

### 4) Mở trình duyệt

```text
http://127.0.0.1:5000
```

## Có gì trong app

- Thêm requirement FR/NFR
- Tự parse template Actor - Action - Object - Constraint
- Tự phát hiện conflict và duplicate
- Tạo relationship và traceability
- Dashboard, biểu đồ và graph quan hệ

## API chính

- `POST /api/requirements`
- `GET /api/requirements`
- `PUT /api/requirements/:id`
- `DELETE /api/requirements/:id`
- `POST /api/relationships`
- `GET /api/requirements/:id/related`
- `POST /api/traceability`
- `GET /api/traceability/:id`
- `GET /api/conflicts`
- `GET /api/dashboard`
- `GET /api/graph`

## Ghi chú

- Khi mở lần đầu, app tự seed dữ liệu mẫu để UI có sẵn nội dung.
- Bộ luật demo hiện tại gồm:
  - conflict: cùng actor + object nhưng action trái nghĩa
  - duplicate: trùng actor + action + object + constraint
