def test_receipt_rejects_spoofed_png(mesero):
    response = mesero.client.post(
        "/api/v1/receipts",
        files={"file": ("receipt.png", b"not a png", "image/png")},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_FILE_CONTENT"


def test_receipt_accepts_valid_png_signature(mesero):
    response = mesero.client.post(
        "/api/v1/receipts",
        files={"file": ("receipt.png", b"\x89PNG\r\n\x1a\nminimal", "image/png")},
    )
    assert response.status_code == 201
    assert response.json()["content_type"] == "image/png"
