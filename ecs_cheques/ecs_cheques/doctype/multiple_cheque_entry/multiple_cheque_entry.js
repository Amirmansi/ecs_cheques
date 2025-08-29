// Copyright (c) 2021, erpcloud.systems and contributors
// Enhanced automatic account detection version
// For license information, please see license.txt

frappe.ui.form.on("Multiple Cheque Entry", {
    setup: function(frm) {
        frm.set_query("bank_acc", () => ({
            filters: [["Bank Account", "bank", "in", frm.doc.cheque_bank]]
        }));
        frm.set_query("cheque_bank", () => ({
            filters: [["Bank", "company_bank", "=", '1']]
        }));
        frm.set_query("mode_of_payment", () => ({
            filters: [["Mode of Payment", "type", "=", 'Cheque']]
        }));
        frm.set_query("party_type", () => ({
            filters: [["DocType", "name", "in", ["Customer", "Supplier"]]]
        }));
    },

    // clear dependent fields
    party_type: function(frm) {
        frm.set_value("party", "");
        frm.set_value("party_name", "");
    },
    cheque_bank: function(frm) {
        frm.set_value("bank_acc", "");
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    bank_acc: function(frm) {
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    payment_type: function(frm) {
        if (frm.doc.payment_type === "Receive") {
            frm.set_value("party_type", "Customer");
        } else if (frm.doc.payment_type === "Pay") {
            frm.set_value("party_type", "Supplier");
        }
    },
    party: function(frm) {
        if (!frm.doc.party_type || !frm.doc.party) return;
        const doctype = frm.doc.party_type === "Customer" ? "Customer" : "Supplier";
        const fieldname = frm.doc.party_type === "Customer" ? "customer_name" : "supplier_name";
        frappe.call({
            method: "frappe.client.get_value",
            args: { doctype, fieldname, filters: { name: frm.doc.party } },
            callback: function(r) {
                frm.set_value("party_name", r.message ? r.message[fieldname] : "");
            }
        });
    },
    validate: function(frm) {
        if (frm.doc.mode_of_payment_type && frm.doc.mode_of_payment_type !== "Cheque") {
            frappe.throw("الطريقة المحددة ليست شيك. اختر طريقة دفع من نوع Cheque.");
        }
    }
});

// ---------------- Helper: Get values from various doctypes ----------------
function getDocValue(doctype, name, fields) {
    return new Promise((resolve, reject) => {
        if (!name) return resolve(null);
        frappe.call({
            method: "frappe.client.get_value",
            args: { doctype, filters: { name }, fieldname: fields },
            callback: function(r) {
                resolve(r && r.message ? r.message : null);
            },
            error: function(err) {
                console.error(`Error fetching ${doctype} ${name}`, err);
                resolve(null); // don't reject - fallback gracefully
            }
        });
    });
}

// Try to find first non-empty from list of keys in an object
function firstNonEmpty(obj, keys) {
    for (let k of keys) {
        if (!obj) continue;
        if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k]) return obj[k];
    }
    return null;
}

// Build robust Payment Entry payload with many alternate field names
function buildPaymentEntryPayload(base, currency) {
    const alternates = {
        // account name variants
        paid_to: base.paid_to,
        paid_from: base.paid_from,
        paid_to_account: base.paid_to,
        paid_from_account: base.paid_from,
        account_paid_to: base.paid_to,
        account_paid_from: base.paid_from,
        paid_to_account_name: base.paid_to,
        paid_from_account_name: base.paid_from,

        // currency variants
        paid_to_account_currency: currency,
        paid_from_account_currency: currency,
        account_paid_to_currency: currency,
        paid_to_currency: currency,
        account_currency_to: currency
    };
    // merge and return
    return Object.assign({}, base, alternates);
}

// Main auto-detect function: returns Promise resolving to { paid_to, paid_from, currency }
async function autoDetectAccounts(frm, isPay, isReceive) {
    // 1) if user explicitly filled custom fields, use them first
    const explicit_paid_to = frm.doc.account_paid_to || frm.doc.account_paid || null;
    const explicit_paid_from = frm.doc.account_paid_from || frm.doc.account_from || null;
    const explicit_currency = frm.doc.account_currency || frm.doc.currency || null;

    if (explicit_paid_to || explicit_paid_from || explicit_currency) {
        return {
            paid_to: explicit_paid_to,
            paid_from: explicit_paid_from,
            currency: explicit_currency
        };
    }

    // 2) Try bank account (Bank Account doctype) if bank_acc is set (Bank Account typically has 'account' field)
    let bankAccountInfo = null;
    if (frm.doc.bank_acc) {
        bankAccountInfo = await getDocValue("Bank Account", frm.doc.bank_acc, ["account", "account_name", "company", "currency"]);
    }
    const bank_acc_account = bankAccountInfo ? (bankAccountInfo.account || bankAccountInfo.account_name) : null;
    const bank_acc_currency = bankAccountInfo ? (bankAccountInfo.currency) : null;

    // 3) Try Mode of Payment doc for a default account
    let mopInfo = null;
    if (frm.doc.mode_of_payment) {
        mopInfo = await getDocValue("Mode of Payment", frm.doc.mode_of_payment, [
            "account", "default_account", "bank_account", "account_head", "company", "currency", "default_bank_account"
        ]);
    }
    const mop_account = mopInfo ? (firstNonEmpty(mopInfo, ["account", "default_account", "bank_account", "default_bank_account", "account_head"])) : null;
    const mop_currency = mopInfo ? (mopInfo.currency || null) : null;

    // 4) Try Party (Customer / Supplier) defaults
    let partyInfo = null;
    if (frm.doc.party && frm.doc.party_type) {
        const party_doctype = frm.doc.party_type === "Customer" ? "Customer" : "Supplier";
        partyInfo = await getDocValue(party_doctype, frm.doc.party, [
            "default_bank_account", "default_account", "receivable_account", "payable_account",
            "default_payment_account", "account", "default_currency"
        ]);
    }
    const party_account = partyInfo ? (firstNonEmpty(partyInfo, ["receivable_account", "payable_account", "default_bank_account", "default_account", "default_payment_account", "account"])) : null;

    // 5) Company currency fallback and optionally company default account (we fetch default_currency)
    let companyInfo = null;
    if (frm.doc.company) {
        companyInfo = await getDocValue("Company", frm.doc.company, ["default_currency"]);
    }
    const company_currency = companyInfo ? (companyInfo.default_currency || null) : null;

    // Compose logic to choose paid_to & paid_from based on payment_type
    // Use explicit values > bank account > mode_of_payment > party defaults > undefined
    const resolved = {
        paid_to: null,
        paid_from: null,
        currency: null
    };

    // Choose currency: explicit > bank_acc_currency > mop_currency > company_currency
    resolved.currency = explicit_currency || bank_acc_currency || mop_currency || company_currency || null;

    // For Pay: we usually send money out, so 'paid_from' is company/bank and 'paid_to' is supplier/payable
    if (isPay) {
        resolved.paid_from = explicit_paid_from || bank_acc_account || mop_account || frm.doc.paid_from || frm.doc.account || null;
        resolved.paid_to = explicit_paid_to || frm.doc.payable_account || party_account || frm.doc.paid_to || null;
    } else if (isReceive) {
        // For Receive: company/bank receives money -> 'paid_to' is bank account; 'paid_from' is customer receivable
        resolved.paid_to = explicit_paid_to || bank_acc_account || mop_account || frm.doc.paid_to || null;
        resolved.paid_from = explicit_paid_from || party_account || frm.doc.paid_from || null;
    } else {
        // Default neutral assignment
        resolved.paid_to = explicit_paid_to || bank_acc_account || mop_account || frm.doc.paid_to || party_account || null;
        resolved.paid_from = explicit_paid_from || frm.doc.paid_from || bank_acc_account || mop_account || null;
    }

    // Final fallback: if still missing, try some existing fields on form
    if (!resolved.paid_to) resolved.paid_to = frm.doc.paid_to || frm.doc.account || frm.doc.payable_account || null;
    if (!resolved.paid_from) resolved.paid_from = frm.doc.paid_from || frm.doc.account || null;

    return resolved;
}

// ---------------- On Submit: create Payment Entries automatically ----------------
frappe.ui.form.on("Multiple Cheque Entry", "on_submit", function(frm) {
    (async () => {
        const isPay = frm.doc.payment_type === "Pay";
        const isReceive = frm.doc.payment_type === "Receive";
        const table = isPay ? frm.doc.cheque_table_2 : frm.doc.cheque_table;
        if (!table || !table.length) {
            frappe.msgprint({ title: __('No Cheques'), message: __('لا توجد شيكات لإنشاء قيد دفع/قبض.') });
            return;
        }

        // Auto-detect accounts & currency
        let resolved;
        try {
            resolved = await autoDetectAccounts(frm, isPay, isReceive);
            console.log("Auto-detected accounts:", resolved);
        } catch (e) {
            console.error("Auto detect failed:", e);
            resolved = { paid_to: null, paid_from: null, currency: null };
        }

        // If still no paid_to found (critical), show a clear message with suggestions
        if (!resolved.paid_to && !resolved.paid_from) {
            frappe.msgprint({
                title: __('Missing Account'),
                message: __('لم يُعثر على حساب صالح تلقائياً. الرجاء تحديد أحد الحقول: Account Paid To أو Paid To أو Payable Account أو Bank Account في الفورم.')
            });
            return;
        }

        // Build docs for rows without payment_entry
        const docs = [];
        table.forEach(row => {
            if (!row.payment_entry) {
                const base = {
                    doctype: "Payment Entry",
                    posting_date: frm.doc.posting_date || frm.doc.transaction_date || frappe.datetime.get_today(),
                    reference_doctype: "Multiple Cheque Entry",
                    reference_link: frm.doc.name,
                    payment_type: frm.doc.payment_type,
                    mode_of_payment: frm.doc.mode_of_payment,
                    mode_of_payment_type: frm.doc.mode_of_payment_type,
                    party_type: frm.doc.party_type,
                    party: frm.doc.party,
                    paid_from: resolved.paid_from,
                    paid_to: resolved.paid_to,
                    cheque_bank: frm.doc.cheque_bank,
                    bank_acc: frm.doc.bank_acc,
                    cheque_type: row.cheque_type,
                    reference_no: row.reference_no,
                    reference_date: row.reference_date,
                    paid_amount: row.paid_amount || row.amount || 0,
                    received_amount: row.paid_amount || row.amount || 0,
                    first_beneficiary: row.first_beneficiary,
                    person_name: row.person_name,
                    issuer_name: row.issuer_name,
                    picture_of_check: row.picture_of_check,
                    cheque_table_no: isReceive ? row.name : undefined,
                    cheque_table_no2: isPay ? row.name : undefined
                };

                // Build payload with alternates and set currency if we resolved one
                const payload = buildPaymentEntryPayload(base, resolved.currency);
                docs.push({ payload, child_row_name: row.name });
            }
        });

        if (!docs.length) {
            frappe.msgprint({ title: __('No new entries'), message: __('كل الشيكات مُرتبطة بقيد دفع بالفعل.') });
            return;
        }

        // Insert & submit sequentially, with per-document error reporting
        let chain = Promise.resolve();
        const results = [];
        docs.forEach(d => {
            chain = chain.then(() => new Promise((resolve, reject) => {
                frappe.call({
                    method: "frappe.client.insert",
                    args: { doc: d.payload },
                    callback: function(inserted) {
                        if (!inserted || !inserted.message) {
                            const errMsg = (inserted && inserted.exc) ? inserted.exc : "Unknown insert error";
                            console.error("Insert failed:", errMsg, inserted);
                            frappe.msgprint({ title: __('Insert Error'), message: __('فشل إدخال قيد الدفع: ') + errMsg });
                            return reject(errMsg);
                        }
                        // submit
                        frappe.call({
                            method: "frappe.client.submit",
                            args: { doc: inserted.message },
                            callback: function(submitted) {
                                if (!submitted || !submitted.message) {
                                    const err2 = (submitted && submitted.exc) ? submitted.exc : "Unknown submit error";
                                    console.error("Submit failed:", err2, submitted);
                                    frappe.msgprint({ title: __('Submit Error'), message: __('فشل تقديم قيد الدفع: ') + err2 });
                                    return reject(err2);
                                }

                                // set child row payment_entry field
                                const child_doctype = isPay ? "Cheque Table Pay" : "Cheque Table Receive";
                                const child_name = d.payload.cheque_table_no || d.payload.cheque_table_no2 || d.child_row_name;
                                if (child_name) {
                                    frappe.db.set_value(child_doctype, child_name, "payment_entry", submitted.message.name)
                                        .then(() => {
                                            results.push(submitted.message);
                                            resolve(submitted.message);
                                        })
                                        .catch((e) => {
                                            console.error("Failed to set child payment_entry:", e);
                                            results.push(submitted.message);
                                            resolve(submitted.message); // still resolve
                                        });
                                } else {
                                    results.push(submitted.message);
                                    resolve(submitted.message);
                                }
                            },
                            error: function(err) {
                                console.error("Submit call error:", err);
                                frappe.msgprint({ title: __('Submit RPC Error'), message: JSON.stringify(err) });
                                reject(err);
                            }
                        });
                    },
                    error: function(err) {
                        console.error("Insert call error:", err);
                        frappe.msgprint({ title: __('Insert RPC Error'), message: JSON.stringify(err) });
                        reject(err);
                    }
                });
            }));
        });

        chain.then(() => {
            frappe.msgprint("تم إنشاء الشيكات وقيد(ق) الدفع بنجاح. راجع المدفوعات والمقبوضات.");
            frm.reload_doc();
        }).catch(err => {
            console.error("One or more Payment Entries failed:", err);
            frappe.msgprint({ title: __('Error'), message: __('حدث خطأ أثناء إنشاء أو تقديم قيود الدفع. راجع السجل في console للمطور.') });
        });
    })();
});

// -------- First Beneficiary Auto-Fill --------
frappe.ui.form.on("Cheque Table Pay", "first_beneficiary", function(frm) {
    frm.doc.cheque_table_2?.forEach(r => {
        r.person_name = frm.doc.party_name;
        r.issuer_name = frm.doc.company;
    });
    frm.refresh_field("cheque_table_2");
});

frappe.ui.form.on("Cheque Table Receive", "first_beneficiary", function(frm) {
    frm.doc.cheque_table?.forEach(r => {
        r.person_name = frm.doc.company;
        r.issuer_name = frm.doc.party_name;
    });
    frm.refresh_field("cheque_table");
});
